// src/ingest/index.ts

import { Types } from "mongoose";
import { FileDocModel } from "../models/FileDoc.js";
import { ChunkModel } from "../models/Chunk.js";
import { getStorage } from "../storage/index.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { extract } from "./extractors/index.js";
import { chunkText } from "./chunker.js";
import { chat } from "../llm/nvidiaClient.js";

const CONCURRENCY = 3;

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(n: number) {
    this.permits = n;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.permits++;
  }
}

const sem = new Semaphore(CONCURRENCY);
const inflight = new Set<Promise<void>>();

async function generateSummaryLine(
  doc: { name: string; mime: string },
  text: string,
): Promise<string | undefined> {
  try {
    const res = await chat({
      model: env.MODEL_FAST,
      messages: [
        {
          role: "user",
          content: `Buat 1 kalimat ringkas (maks 100 karakter) dalam bahasa Indonesia yang menjelaskan isi file "${doc.name}" (${doc.mime}). Fokus pada isi, bukan metadata.\n\nCuplikan:\n${text.slice(0, 1200)}`,
        },
      ],
      max_tokens: 60,
      temperature: 0.2,
    });
    const line = (res.choices[0]?.message.content ?? "").trim();
    return line && line.length <= 200 ? line : undefined;
  } catch (err) {
    logger.warn({ err }, "summaryLine generation failed");
    return undefined;
  }
}

async function processOne(fileId: string): Promise<void> {
  await sem.acquire();
  try {
    const doc = await FileDocModel.findById(fileId);
    if (!doc || doc.status === "ready" || doc.status === "failed") return;
    if (doc.status !== "processing") return;

    try {
      const storage = getStorage();
      const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
      const length = Math.min(doc.size, maxBytes);
      const bytes = await storage.readBytes(doc.storage.key, length);
      const buf = Buffer.from(bytes);

      const ex = await extract(buf, doc.name, doc.mime);

      let text = ex.text;
      let truncated = ex.truncated ?? false;
      if (text.length > env.MAX_DOC_CHARS) {
        text = text.slice(0, env.MAX_DOC_CHARS);
        truncated = true;
      }

      const summaryLine = text
        ? await generateSummaryLine({ name: doc.name, mime: doc.mime }, text)
        : ex.digest?.summary;

      doc.extract = {
        kind: ex.kind,
        chars: text.length,
        ...(ex.pages !== undefined ? { pages: ex.pages } : {}),
        ...(ex.sheets !== undefined ? { sheets: ex.sheets } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      if (ex.digest) doc.digest = ex.digest;
      if (summaryLine) doc.summaryLine = summaryLine;

      if (text) {
        const chunks = chunkText(text);
        await ChunkModel.deleteMany({ fileId: doc._id });
        if (chunks.length > 0) {
          await ChunkModel.insertMany(
            chunks.map((t, i) => ({
              fileId: doc._id,
              sessionId: doc.sessionId,
              idx: i,
              text: t,
            })),
          );
        }
      }

      doc.status = "ready";
      doc.error = undefined;
      await doc.save();
      logger.info({ fileId, kind: ex.kind, chars: text.length }, "ingested");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, fileId }, "ingestion failed");
      doc.status = "failed";
      doc.error = msg;
      await doc.save();
    }
  } finally {
    sem.release();
  }
}

export function enqueueIngestion(fileId: string): void {
  const p = processOne(fileId).finally(() => inflight.delete(p));
  inflight.add(p);
}

/**
 * Tunggu semua file berstatus ready/failed, timeout MAX.
 * Polling 500ms (ingestion lewat proses terpisah di queue).
 */
export async function waitForReady(
  fileIds: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const oids = fileIds.filter((id) => Types.ObjectId.isValid(id));
  if (oids.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const docs = await FileDocModel.find({ _id: { $in: oids } })
      .select({ status: 1 })
      .lean();
    if (docs.every((d) => d.status === "ready" || d.status === "failed")) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  throw new Error("timeout waiting for attachments");
}
