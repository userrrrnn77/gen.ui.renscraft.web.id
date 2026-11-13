// src/services/tools/attachments.ts

import { z } from "zod";
import { env } from "../../config/env.js";
import { Types } from "mongoose";
import { registerTool, okResult, errorResult } from "./registry.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { ChunkModel } from "../../models/Chunk.js";
import { getStorage } from "../../storage/index.js";
import { visionQuery } from "../ingest/vision.js";
import { logger } from "../../config/logger.js";
import { embedTexts, cosineSimilarity } from "../ingest/embedder.js";

// ─── read_attachment ──────────────────────────────────────────────────────

const ReadAttachmentSchema = z.object({
  fileId: z.string(),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(100).max(20_000).optional(),
});

registerTool({
  name: "read_attachment",
  kind: "attachment",
  description:
    "Baca isi teks file yang sudah di-upload/dibuat di sesi ini, per potongan. Gunakan saat dokumen besar atau info ada di bagian tertentu.",
  schema: ReadAttachmentSchema,
  async run(args, ctx) {
    const a = ReadAttachmentSchema.parse(args);
    if (!Types.ObjectId.isValid(a.fileId)) {
      return errorResult("INVALID_ID", "fileId tidak valid");
    }
    const doc = await FileDocModel.findOne({
      _id: a.fileId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    }).lean();
    if (!doc)
      return errorResult("NOT_FOUND", "File tidak ditemukan di sesi ini");
    if (doc.status !== "ready") {
      return errorResult("NOT_READY", `Status file: ${doc.status}`);
    }
    if (doc.digest && !doc.extract?.chars) {
      return okResult({
        text: doc.digest.summary ?? "",
        ocr: doc.digest.ocrText ?? "",
        kind: "image",
        total:
          (doc.digest.summary?.length ?? 0) + (doc.digest.ocrText?.length ?? 0),
      });
    }

    const chunks = await ChunkModel.find({ fileId: doc._id })
      .sort({ idx: 1 })
      .lean();
    const full = chunks.map((c) => c.text).join("");
    const offset = a.offset ?? 0;
    const maxChars = a.maxChars ?? 8000;
    const slice = full.slice(offset, offset + maxChars);

    return okResult({
      text: slice,
      offset,
      returned: slice.length,
      total: full.length,
      truncated: offset + slice.length < full.length,
    });
  },
});

// ─── search_attachment ────────────────────────────────────────────────────

const SearchAttachmentSchema = z.object({
  query: z.string().min(1).max(200),
  fileId: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

const EMBEDDING_SCAN_LIMIT = 2000;
const RRF_K = 60;

interface SearchHit {
  fileId: string;
  idx: number;
  score: number;
  text: string;
  source: "semantic" | "text" | "both";
}

interface RawChunk {
  _id: unknown;
  fileId: unknown;
  idx: number;
  text: string;
  embedding?: number[];
}

async function searchHybrid(
  query: string,
  baseFilter: Record<string, unknown>,
  limit: number,
): Promise<SearchHit[]> {
  const fetchN = Math.max(limit * 3, 15);

  // 1. Semantic candidates (kalau embedding enabled dan query embed OK).
  let queryVec: number[] | null = null;
  try {
    const vecs = await embedTexts([query], "query");
    queryVec = vecs[0];
  } catch (err) {
    logger.warn({ err }, "query embedding failed; text-only fallback");
  }

  const semanticRanked: Array<RawChunk & { sim: number }> = [];
  if (queryVec) {
    const candidates = (await ChunkModel.find({
      ...baseFilter,
      embedding: { $exists: true },
    })
      .select({ fileId: 1, idx: 1, text: 1, embedding: 1 })
      .sort({ _id: -1 })
      .limit(EMBEDDING_SCAN_LIMIT)
      .lean()) as unknown as RawChunk[];

    for (const c of candidates) {
      if (!Array.isArray(c.embedding)) continue;
      const sim = cosineSimilarity(queryVec, c.embedding);
      semanticRanked.push({ ...c, sim });
    }
    semanticRanked.sort((a, b) => b.sim - a.sim);
  }

  // 2. Text candidates via $text. Bisa gagal kalau query hanya stopword.
  let textRanked: RawChunk[] = [];
  try {
    textRanked = (await ChunkModel.find(
      { ...baseFilter, $text: { $search: query } },
      { score: { $meta: "textScore" } },
    )
      .sort({ score: { $meta: "textScore" } })
      .limit(fetchN)
      .lean()) as unknown as RawChunk[];
  } catch (err) {
    logger.debug({ err }, "text search failed");
  }

  // 3. Gabung dengan Reciprocal Rank Fusion.
  const merged = new Map<
    string,
    {
      fileId: string;
      idx: number;
      text: string;
      rrf: number;
      inSemantic: boolean;
      inText: boolean;
    }
  >();

  const topSemantic = semanticRanked.slice(0, fetchN);
  for (let i = 0; i < topSemantic.length; i++) {
    const s = topSemantic[i];
    const id = String(s._id);
    merged.set(id, {
      fileId: String(s.fileId),
      idx: s.idx,
      text: s.text,
      rrf: 1 / (RRF_K + i + 1),
      inSemantic: true,
      inText: false,
    });
  }

  for (let i = 0; i < textRanked.length; i++) {
    const t = textRanked[i];
    const id = String(t._id);
    const existing = merged.get(id);
    if (existing) {
      existing.rrf += 1 / (RRF_K + i + 1);
      existing.inText = true;
    } else {
      merged.set(id, {
        fileId: String(t.fileId),
        idx: t.idx,
        text: t.text,
        rrf: 1 / (RRF_K + i + 1),
        inSemantic: false,
        inText: true,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((m) => ({
      fileId: m.fileId,
      idx: m.idx,
      score: m.rrf,
      text: m.text.slice(0, 800),
      source:
        m.inSemantic && m.inText ? "both" : m.inSemantic ? "semantic" : "text",
    }));
}

async function searchTextOnly(
  query: string,
  baseFilter: Record<string, unknown>,
  limit: number,
): Promise<SearchHit[]> {
  const results = (await ChunkModel.find(
    { ...baseFilter, $text: { $search: query } },
    { score: { $meta: "textScore" } },
  )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .lean()) as unknown as Array<RawChunk & { score?: number }>;

  return results.map((r) => ({
    fileId: String(r.fileId),
    idx: r.idx,
    score: r.score ?? 0,
    text: r.text.slice(0, 800),
    source: "text" as const,
  }));
}

registerTool({
  name: "search_attachment",
  kind: "attachment",
  description:
    "Cari potongan teks dalam lampiran sesi. Mendukung pencarian semantik (makna) dan literal. Gunakan untuk dokumen besar yang tidak bisa di-inline penuh.",
  schema: SearchAttachmentSchema,
  async run(args, ctx) {
    const a = SearchAttachmentSchema.parse(args);

    const baseFilter: Record<string, unknown> = { sessionId: ctx.sessionId };
    if (a.fileId) {
      if (!Types.ObjectId.isValid(a.fileId)) {
        return errorResult("INVALID_ID", "fileId tidak valid");
      }
      baseFilter.fileId = new Types.ObjectId(a.fileId);
    }

    const limit = a.limit ?? 5;

    try {
      const hits = env.EMBEDDING_ENABLED
        ? await searchHybrid(a.query, baseFilter, limit)
        : await searchTextOnly(a.query, baseFilter, limit);
      return okResult({
        hits,
        mode: env.EMBEDDING_ENABLED ? "hybrid" : "text",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult("SEARCH_FAILED", msg);
    }
  },
});

// ─── inspect_image ────────────────────────────────────────────────────────

const InspectImageSchema = z.object({
  fileId: z.string(),
  question: z.string().min(1).max(500),
});

registerTool({
  name: "inspect_image",
  kind: "attachment",
  description:
    "Tanya ulang model vision tentang gambar yang sudah di-upload (baca teks, detail, dsb).",
  schema: InspectImageSchema,
  async run(args, ctx) {
    const a = InspectImageSchema.parse(args);
    if (!Types.ObjectId.isValid(a.fileId)) {
      return errorResult("INVALID_ID", "fileId tidak valid");
    }
    const doc = await FileDocModel.findOne({
      _id: a.fileId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    }).lean();
    if (!doc) return errorResult("NOT_FOUND", "File tidak ditemukan");
    if (!doc.mime.startsWith("image/")) {
      return errorResult("NOT_IMAGE", `File bukan gambar (${doc.mime})`);
    }

    const storage = getStorage();
    const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
    const length = Math.min(doc.size, maxBytes);
    const bytes = await storage.readBytes(doc.storage.key, length);
    const answer = await visionQuery(Buffer.from(bytes), a.question);
    return okResult({ answer });
  },
});
