// src/services/rag/vectorStore.ts
import type { Types } from "mongoose";
import { ChunkModel } from "../../models/Chunk.js";
import { cosineSimilarity } from "../ingest/embedder.js";

const EMBEDDING_SCAN_LIMIT = 2000;

export interface VectorSearchResult {
  chunkId: Types.ObjectId;
  fileId: Types.ObjectId;
  idx: number;
  text: string;
  sim: number;
}

export interface VectorStore {
  search(
    queryVec: number[],
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<VectorSearchResult[]>;
}

interface RawChunk {
  _id: Types.ObjectId;
  fileId: Types.ObjectId;
  idx: number;
  text: string;
  embedding?: number[];
}

/**
 * Mongo implementation. Cosine in-memory (scan ≤ EMBEDDING_SCAN_LIMIT
 * chunk terbaru). Sesuai PRD D3 — tanpa pgvector.
 */
class MongoVectorStore implements VectorStore {
  async search(
    queryVec: number[],
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const candidates = (await ChunkModel.find({
      ...filter,
      embedding: { $exists: true },
    })
      .select({ fileId: 1, idx: 1, text: 1, embedding: 1 })
      .sort({ _id: -1 })
      .limit(EMBEDDING_SCAN_LIMIT)
      .lean()) as unknown as RawChunk[];

    const scored: VectorSearchResult[] = [];
    for (const c of candidates) {
      if (!Array.isArray(c.embedding)) continue;
      const sim = cosineSimilarity(queryVec, c.embedding);
      scored.push({
        chunkId: c._id,
        fileId: c.fileId,
        idx: c.idx,
        text: c.text,
        sim,
      });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit);
  }
}

let instance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!instance) instance = new MongoVectorStore();
  return instance;
}
