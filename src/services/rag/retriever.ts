// src/services/rag/retriever.ts
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { ChunkModel } from "../../models/Chunk.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { embedTexts } from "../ingest/embedder.js";
import { getVectorStore } from "./vectorStore.js";
import type { RetrievedChunk, RetrieveOptions } from "./types.js";

const RRF_K = 60;

interface RawTextChunk {
  _id: Types.ObjectId;
  fileId: Types.ObjectId;
  idx: number;
  text: string;
}

function buildBaseFilter(opts: RetrieveOptions): Record<string, unknown> {
  const f: Record<string, unknown> = { sessionId: opts.sessionId };
  if (opts.fileIds && opts.fileIds.length > 0) {
    f.fileId = {
      $in: opts.fileIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id)),
    };
  } else if (opts.excludeFileIds && opts.excludeFileIds.length > 0) {
    f.fileId = {
      $nin: opts.excludeFileIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id)),
    };
  }
  return f;
}

async function resolveQueryVec(
  question: string,
  opts: RetrieveOptions,
): Promise<number[] | null> {
  if (opts.queryVec !== undefined) {
    try {
      return await opts.queryVec;
    } catch (err) {
      logger.warn({ err }, "queryVec promise rejected; text-only fallback");
      return null;
    }
  }
  if (!env.EMBEDDING_ENABLED) return null;
  try {
    const vecs = await embedTexts([question], "query");
    return vecs[0] ?? null;
  } catch (err) {
    logger.warn({ err }, "query embedding failed; text-only fallback");
    return null;
  }
}

interface Merged {
  chunkId: Types.ObjectId;
  fileId: Types.ObjectId;
  idx: number;
  text: string;
  rrf: number;
  inSemantic: boolean;
  inText: boolean;
  sim?: number;
}

/**
 * Hybrid retrieval (vector + $text) dengan Reciprocal Rank Fusion.
 * Source tunggal kebenaran untuk tool `search_attachment` dan pipeline RAG.
 */
export async function retrieveRelevantChunks(
  question: string,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? env.RAG_TOP_K;
  const minSim = opts.minSim ?? env.RAG_MIN_SIM;
  const baseFilter = buildBaseFilter(opts);

  // 1. Semantic
  const queryVec = await resolveQueryVec(question, opts);
  const semanticRanked: Array<{
    chunkId: Types.ObjectId;
    fileId: Types.ObjectId;
    idx: number;
    text: string;
    sim: number;
  }> = [];
  if (queryVec) {
    const vs = getVectorStore();
    const results = await vs.search(queryVec, baseFilter, topK * 3);
    for (const r of results) {
      semanticRanked.push({
        chunkId: r.chunkId,
        fileId: r.fileId,
        idx: r.idx,
        text: r.text,
        sim: r.sim,
      });
    }
  }

  // 2. Text search
  let textRanked: RawTextChunk[] = [];
  try {
    textRanked = (await ChunkModel.find(
      { ...baseFilter, $text: { $search: question } },
      { score: { $meta: "textScore" } },
    )
      .sort({ score: { $meta: "textScore" } })
      .limit(topK * 3)
      .lean()) as unknown as RawTextChunk[];
  } catch (err) {
    logger.debug({ err }, "text search failed");
  }

  // 3. RRF merge
  const merged = new Map<string, Merged>();

  for (let i = 0; i < semanticRanked.length; i++) {
    const s = semanticRanked[i];
    const id = String(s.chunkId);
    merged.set(id, {
      chunkId: s.chunkId,
      fileId: s.fileId,
      idx: s.idx,
      text: s.text,
      rrf: 1 / (RRF_K + i + 1),
      inSemantic: true,
      inText: false,
      sim: s.sim,
    });
  }

  for (let i = 0; i < textRanked.length; i++) {
    const t = textRanked[i];
    const id = String(t._id);
    const existing = merged.get(id);
    const contribution = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.rrf += contribution;
      existing.inText = true;
    } else {
      merged.set(id, {
        chunkId: t._id,
        fileId: t.fileId,
        idx: t.idx,
        text: t.text,
        rrf: contribution,
        inSemantic: false,
        inText: true,
      });
    }
  }

  // 4. Filter: buang semantic-only di bawah minSim. Both & text-only tetap.
  const kept: Merged[] = [];
  for (const m of merged.values()) {
    const semanticOnlyBelowThreshold =
      m.inSemantic && !m.inText && m.sim !== undefined && m.sim < minSim;
    if (semanticOnlyBelowThreshold) continue;
    kept.push(m);
  }

  kept.sort((a, b) => b.rrf - a.rrf);
  const top = kept.slice(0, topK);

  // 5. Join nama file
  const fileIds = [...new Set(top.map((c) => String(c.fileId)))];
  const fileDocs = await FileDocModel.find({ _id: { $in: fileIds } })
    .select({ _id: 1, name: 1 })
    .lean();
  const nameMap = new Map(fileDocs.map((d) => [String(d._id), d.name]));

  return top.map((m) => ({
    chunkId: String(m.chunkId),
    fileId: String(m.fileId),
    fileName: nameMap.get(String(m.fileId)) ?? "unknown",
    idx: m.idx,
    text: m.text,
    ...(m.sim !== undefined ? { sim: m.sim } : {}),
    rrf: m.rrf,
    source:
      m.inSemantic && m.inText ? "both" : m.inSemantic ? "semantic" : "text",
  }));
}

export function shouldRetrieve(input: {
  text: string;
  attachmentIds: string[];
  files: Array<{ _id: unknown; status: string }>;
  enabled: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.text.length < 8) return false;
  const inlined = new Set(input.attachmentIds);
  return input.files.some(
    (f) => f.status === "ready" && !inlined.has(String(f._id)),
  );
}
