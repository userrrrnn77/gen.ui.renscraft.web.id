// src/services/ingest/embedder.ts

import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { ChunkModel } from "../../models/Chunk.js";

const EMBEDDING_PATH = "/embeddings";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 60_000;

export type EmbedInputType = "query" | "passage";

interface EmbedResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
}

/**
 * Embed array of texts via NVIDIA /embeddings. Order dijamin sama dengan
 * input. Throw kalau dimensi hasil tidak sesuai EMBEDDING_DIM.
 */
export async function embedTexts(
  inputs: string[],
  inputType: EmbedInputType,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!env.EMBEDDING_ENABLED) {
    throw new Error("embedding disabled");
  }
  if (inputs.length === 0) return [];

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${env.NVIDIA_BASE_URL}${EMBEDDING_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: env.EMBEDDING_MODEL,
          input: inputs,
          input_type: inputType,
          encoding_format: "float",
          truncate: "END",
        }),
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt < MAX_ATTEMPTS) {
          logger.warn({ attempt, status: res.status }, "embedding retry");
          await backoff(attempt);
          continue;
        }
        throw new Error(`embedding ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = (await res.json()) as EmbedResponse;
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== inputs.length) {
        throw new Error(
          `embedding count mismatch: expected ${inputs.length}, got ${sorted.length}`,
        );
      }
      for (const item of sorted) {
        if (item.embedding.length !== env.EMBEDDING_DIM) {
          throw new Error(
            `embedding dim mismatch: expected ${env.EMBEDDING_DIM}, got ${item.embedding.length}`,
          );
        }
      }
      return sorted.map((d) => d.embedding);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ attempt, err }, "embedding attempt failed");
        await backoff(attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Embed chunks dan update dokumennya. Fire-and-forget safe: kalau satu batch
 * gagal, batch lain tetap dicoba; yang gagal tetap tersimpan tanpa embedding
 * (fallback ke $text search).
 */
export async function embedAndStoreChunks(
  chunks: Array<{ _id: Types.ObjectId; text: string }>,
): Promise<void> {
  if (!env.EMBEDDING_ENABLED || chunks.length === 0) return;

  const batchSize = env.EMBEDDING_BATCH_SIZE;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.text);
    try {
      const vecs = await embedTexts(texts, "passage");
      const now = new Date();
      await Promise.all(
        batch.map((c, j) =>
          ChunkModel.updateOne(
            { _id: c._id },
            {
              $set: {
                embedding: vecs[j],
                embeddingModel: env.EMBEDDING_MODEL,
                embeddedAt: now,
              },
            },
          ),
        ),
      );
    } catch (err) {
      logger.warn(
        {
          err,
          batchStart: i,
          batchSize: batch.length,
        },
        "embed batch failed; chunks remain unembedded",
      );
    }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
