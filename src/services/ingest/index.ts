// src/services/ingest/index.ts
import { Types } from "mongoose";
import { FileDocModel, type FileIndexStatus } from "../../models/FileDoc.js";
import { ChunkModel } from "../../models/Chunk.js";
import { getStorage } from "../../storage/index.js";
import { env, SUMMARY_MODEL } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { extract } from "./extractors/index.js";
import { chunkText } from "./chunker.js";
import { chat } from "../llm/nvidiaClient.js";
import { embedAndStoreChunks } from "./embedder.js";

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

const SUMMARY_LINE_MAX_TOKENS = 3000;
const SUMMARY_LINE_TIMEOUT_MS = 60_000;

async function generateSummaryLine(
  doc: { name: string; mime: string },
  text: string,
): Promise<string | undefined> {
  try {
    const res = await chat(
      {
        model: SUMMARY_MODEL,
        messages: [
          {
            role: "user",
            content: `Buat 1 kalimat ringkas (maks 100 karakter) dalam bahasa Indonesia yang menjelaskan isi file "${doc.name}" (${doc.mime}). Fokus pada isi, bukan metadata.\n\nCuplikan:\n${text.slice(0, 1200)}`,
          },
        ],
        max_tokens: SUMMARY_LINE_MAX_TOKENS,
        temperature: 0.2,
      },
      undefined,
      SUMMARY_LINE_TIMEOUT_MS,
    );
    const msg = res.choices[0]?.message;
    const line = (msg?.content ?? "").trim();
    if (!line) {
      logger.warn(
        {
          fileId: doc.name,
          model: SUMMARY_MODEL,
          finishReason: res.choices[0]?.finish_reason ?? null,
          reasoningLen: (msg?.reasoning_content ?? "").length,
        },
        "summaryLine returned empty content",
      );
      return undefined;
    }
    return line.length <= 200 ? line : undefined;
  } catch (err) {
    logger.warn({ err }, "summaryLine generation failed");
    return undefined;
  }
}

/**
 * Jalankan embedding untuk file dan update `indexStatus`.
 * Selalu menulis status final (`ready` atau `failed`) — bahkan bila
 * `updateOne` sendiri gagal, catch di bawah men-set `failed` (best-effort).
 * Ini mencegah file stuck di `indexing` selamanya.
 */
async function runEmbeddingForFile(
  fileId: Types.ObjectId,
  chunks: Array<{ _id: Types.ObjectId; text: string }>,
): Promise<void> {
  try {
    await FileDocModel.updateOne(
      { _id: fileId },
      { $set: { indexStatus: "indexing" } },
    );
    const result = await embedAndStoreChunks(chunks);
    const finalStatus: FileIndexStatus =
      result.embedded === 0 ? "failed" : "ready";
    await FileDocModel.updateOne(
      { _id: fileId },
      { $set: { indexStatus: finalStatus } },
    );
  } catch (err) {
    logger.warn(
      { err, fileId: fileId.toString() },
      "runEmbeddingForFile failed; marking as failed",
    );
    await FileDocModel.updateOne(
      { _id: fileId },
      { $set: { indexStatus: "failed" } },
    ).catch(() => {
      // Kalau update status pun gagal (mis. file sudah dihapus), tidak
      // ada yang bisa dilakukan. Resume berikutnya akan sweep.
    });
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

      const stillProcessing = await FileDocModel.findOne({
        _id: doc._id,
        status: "processing",
      })
        .select({ _id: 1 })
        .lean();
      if (!stillProcessing) {
        logger.info(
          { fileId },
          "ingestion aborted (file deleted or status changed during extraction)",
        );
        return;
      }

      doc.extract = {
        kind: ex.kind,
        chars: text.length,
        ...(ex.pages !== undefined ? { pages: ex.pages } : {}),
        ...(ex.sheets !== undefined ? { sheets: ex.sheets } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      if (ex.digest) doc.digest = ex.digest;
      if (summaryLine) doc.summaryLine = summaryLine;

      let insertedChunks: Array<{ _id: Types.ObjectId; text: string }> = [];

      if (text) {
        const chunks = chunkText(text);
        await ChunkModel.deleteMany({ fileId: doc._id });
        if (chunks.length > 0) {
          const inserted = await ChunkModel.insertMany(
            chunks.map((t, i) => ({
              fileId: doc._id,
              sessionId: doc.sessionId,
              idx: i,
              text: t,
            })),
          );
          insertedChunks = inserted.map((c) => ({
            _id: c._id,
            text: c.text,
          }));

          const stillExists = await FileDocModel.exists({ _id: doc._id });
          if (!stillExists) {
            await ChunkModel.deleteMany({ fileId: doc._id });
            logger.info(
              { fileId },
              "ingestion aborted: file deleted during chunk insert",
            );
            return;
          }
        }
      }

      doc.status = "ready";
      doc.error = undefined;
      doc.indexStatus = env.EMBEDDING_ENABLED ? "pending" : "disabled";
      await doc.save();
      logger.info({ fileId, kind: ex.kind, chars: text.length }, "ingested");

      if (insertedChunks.length > 0 && env.EMBEDDING_ENABLED) {
        const embedPromise = runEmbeddingForFile(
          doc._id,
          insertedChunks,
        ).finally(() => inflight.delete(embedPromise));
        inflight.add(embedPromise);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, fileId }, "ingestion failed");
      try {
        doc.status = "failed";
        doc.error = msg;
        await doc.save();
      } catch {
        // FileDoc mungkin sudah dihapus; abaikan.
      }
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
 * Startup recovery untuk file yang berhenti di tengah ingestion / embedding
 * karena crash. Idempotent — aman dipanggil berulang.
 *
 * Single-instance assumption (Modular Monolith per PRD): semua status
 * `pending`/`indexing` saat startup dianggap stale. Multi-instance deployment
 * akan butuh lease/lock (di luar scope).
 */
export async function resumePendingEmbeddings(): Promise<void> {
  if (!env.EMBEDDING_ENABLED) return;
  try {
    const candidates = await FileDocModel.find({
      status: "ready",
      indexStatus: { $in: ["pending", "indexing"] },
    })
      .select({ _id: 1 })
      .lean();

    if (candidates.length === 0) return;
    logger.info(
      { count: candidates.length },
      "resuming embedding for pending/indexing files",
    );

    for (const f of candidates) {
      const fileId = f._id;
      const chunks = await ChunkModel.find({ fileId })
        .select({ _id: 1, text: 1 })
        .lean();

      if (chunks.length === 0) {
        // File tidak punya chunks — biasanya extraction kosong. Bukan
        // kegagalan; set disabled agar tidak di-resume terus-menerus.
        await FileDocModel.updateOne(
          { _id: fileId },
          { $set: { indexStatus: "disabled" } },
        );
        continue;
      }

      const p = runEmbeddingForFile(
        fileId,
        chunks.map((c) => ({ _id: c._id, text: c.text })),
      ).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  } catch (err) {
    logger.warn({ err }, "resumePendingEmbeddings failed");
  }
}

/**
 * Re-enqueue files stuck at status="processing" (typically from a crash
 * during a previous run). Idempotent: processOne re-checks status before
 * doing any work, and a file whose processing completes between calls is
 * safely skipped. Call once at bootstrap.
 */
export async function resumePendingIngestion(): Promise<void> {
  try {
    const stuck = await FileDocModel.find({ status: "processing" })
      .select({ _id: 1 })
      .lean();
    if (stuck.length === 0) return;
    logger.info(
      { count: stuck.length },
      "resuming ingestion for stuck processing files",
    );
    for (const f of stuck) {
      enqueueIngestion(f._id.toString());
    }
  } catch (err) {
    logger.warn({ err }, "resumePendingIngestion failed");
  }
}

/**
 * Tunggu semua file berstatus ready/failed, timeout MAX.
 * Throw bila salah satu fileId sudah tidak ada (mis. dihapus user).
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
    if (docs.length < oids.length) {
      throw new Error("attachment file no longer exists");
    }
    if (docs.every((d) => d.status === "ready" || d.status === "failed")) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  throw new Error("timeout waiting for attachments");
}

export async function drainIngestion(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size > 0 && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  if (inflight.size > 0) {
    logger.warn({ remaining: inflight.size }, "ingestion not drained in time");
  }
}
