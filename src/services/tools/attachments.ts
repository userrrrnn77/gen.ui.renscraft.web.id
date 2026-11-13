// src/services/tools/attachments.ts

import { z } from "zod";
import { env } from "../../config/env.js";
import { Types } from "mongoose";
import { registerTool, okResult, errorResult } from "./registry.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { ChunkModel } from "../../models/Chunk.js";
import { getStorage } from "../../storage/index.js";
import { visionQuery } from "../ingest/vision.js";
import { retrieveRelevantChunks } from "../rag/retriever.js";

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

registerTool({
  name: "search_attachment",
  kind: "attachment",
  description:
    "Cari potongan teks dalam lampiran sesi. Mendukung pencarian semantik (makna) dan literal. Gunakan untuk dokumen besar yang tidak bisa di-inline penuh.",
  schema: SearchAttachmentSchema,
  async run(args, ctx) {
    const a = SearchAttachmentSchema.parse(args);

    if (a.fileId && !Types.ObjectId.isValid(a.fileId)) {
      return errorResult("INVALID_ID", "fileId tidak valid");
    }

    const limit = a.limit ?? 5;

    try {
      const chunks = await retrieveRelevantChunks(a.query, {
        sessionId: ctx.sessionId,
        ...(a.fileId ? { fileIds: [a.fileId] } : {}),
        topK: limit,
        // Explicit user search — jangan filter by sim threshold.
        minSim: 0,
      });
      const hits = chunks.map((c) => ({
        fileId: c.fileId,
        idx: c.idx,
        score: c.rrf,
        text: c.text.slice(0, 800),
        source: c.source,
      }));
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
