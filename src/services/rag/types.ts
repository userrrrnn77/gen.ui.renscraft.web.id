// src/services/rag/types.ts
import type { Types } from "mongoose";

export interface RetrievedChunk {
  chunkId: string;
  fileId: string;
  fileName: string;
  idx: number;
  text: string;
  sim?: number;
  rrf: number;
  source: "semantic" | "text" | "both";
}

export interface RetrieveOptions {
  sessionId: Types.ObjectId;
  fileIds?: string[];
  excludeFileIds?: string[];
  topK?: number;
  /** Default: env.RAG_MIN_SIM. Set 0 untuk tool explicit search. */
  minSim?: number;
  /** Promise pre-embed (Phase 3). Null = text-only. */
  queryVec?: Promise<number[] | null>;
  signal?: AbortSignal;
}

export interface SourcePayload {
  n: number;
  fileId: string;
  name: string;
  idx: number;
  snippet: string;
}
