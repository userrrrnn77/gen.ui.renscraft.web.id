// src/controllers/filesController.ts

import type { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { fileTypeFromBuffer } from "file-type";
import { FileDocModel } from "../models/FileDoc.js";
import { SessionModel } from "../models/Session.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseFileId } from "../utils/params.js";
import { getStorage, pickPrefix } from "../storage/index.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { enqueueIngestion } from "../ingest/index.js";

const PRESIGN_TTL_SEC = 600;
const MAGIC_BYTES_LEN = 4100;
const MAX_CONTENT_PREVIEW_BYTES = 200 * 1024;

// ─── Mime helpers ──────────────────────────────────────────────────────────

const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "html",
  "htm",
  "xml",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "sh",
  "sql",
  "log",
  "ini",
  "env",
  "toml",
]);

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
]);

const ZIP_BASED_EXTS = new Set(["docx", "xlsx", "pptx", "odt", "odp"]);

function isTextish(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

function looksLikeText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n));
    return true;
  } catch {
    return false;
  }
}

function ext(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function basicMimeCheck(name: string, mime: string): void {
  const e = ext(name);
  if (!e) throw AppError.badRequest("File has no extension");

  if (mime.startsWith("image/")) {
    const imgExt = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
    if (!imgExt.includes(e)) {
      throw new AppError("UNSUPPORTED_MIME", 415, `Ext .${e} != ${mime}`);
    }
    return;
  }

  if (mime === "application/pdf" && e !== "pdf") {
    throw new AppError("UNSUPPORTED_MIME", 415, "Ext != pdf");
  }
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const PresignBody = z.object({
  sessionId: z.string().refine((v) => Types.ObjectId.isValid(v), {
    message: "Invalid sessionId",
  }),
  name: z.string().min(1).max(200).trim(),
  mime: z.string().min(1).max(120).trim(),
  size: z.number().int().positive(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

// ─── Presign ───────────────────────────────────────────────────────────────

export async function presignUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const body = PresignBody.parse(req.body);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({
    _id: body.sessionId,
    userId,
  }).lean();
  if (!session) throw AppError.notFound("Session not found");

  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (body.size > maxBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      413,
      `Max ${env.MAX_UPLOAD_MB} MB per file`,
    );
  }

  basicMimeCheck(body.name, body.mime);

  const prefix = pickPrefix(body.mime);
  const storage = getStorage();
  const presigned = await storage.presignPut(prefix, body.name, {
    mime: body.mime,
    expiresInSec: PRESIGN_TTL_SEC,
  });

  const doc = await FileDocModel.create({
    userId,
    sessionId: session._id,
    origin: "upload",
    name: body.name,
    mime: body.mime,
    size: body.size,
    sha256: body.sha256 ?? "",
    version: 1,
    parentFileId: null,
    storage: { driver: "r2", key: presigned.key },
    status: "pending",
  });

  res.status(201).json({
    fileId: doc._id.toString(),
    key: presigned.key,
    uploadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
    requiredHeaders: { "Content-Type": body.mime },
  });
}

// ─── Complete ──────────────────────────────────────────────────────────────

export async function completeUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseFileId(req.params.id);
  const userId = getUserId(res);

  const doc = await FileDocModel.findOne({ _id: id, userId });
  if (!doc) throw AppError.notFound();
  if (doc.status !== "pending") {
    throw AppError.conflict(`File is not pending (status: ${doc.status})`);
  }

  const storage = getStorage();
  const markFailed = async (msg: string): Promise<void> => {
    doc.status = "failed";
    doc.error = msg;
    await doc.save();
  };

  // 1. Objek benar-benar ada di R2.
  const head = await storage.head(doc.storage.key);
  if (!head) {
    await markFailed("Object not found in storage");
    throw new AppError(
      "UPLOAD_MISSING",
      404,
      "Uploaded object not found in storage",
    );
  }

  // 2. Size aktual harus cocok dan ≤ MAX_UPLOAD_MB.
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (head.size > maxBytes) {
    await storage.delete(doc.storage.key).catch(() => {});
    await markFailed(`Actual size ${head.size} exceeds limit`);
    throw new AppError("PAYLOAD_TOO_LARGE", 413, "Actual size exceeds limit");
  }
  if (head.size !== doc.size) {
    await storage.delete(doc.storage.key).catch(() => {});
    await markFailed(
      `Size mismatch: declared ${doc.size}, actual ${head.size}`,
    );
    throw new AppError(
      "SIZE_MISMATCH",
      415,
      `Size mismatch: declared ${doc.size}, actual ${head.size}`,
    );
  }

  // 3. Magic byte check (range GET 4KB).
  let detectedMime = doc.mime;
  try {
    const magic = await storage.readBytes(doc.storage.key, MAGIC_BYTES_LEN);
    const detected = await fileTypeFromBuffer(magic);

    if (detected) {
      const sameFamily =
        detected.mime === doc.mime ||
        (detected.mime === "application/zip" &&
          ZIP_BASED_EXTS.has(ext(doc.name)));
      if (!sameFamily) {
        await storage.delete(doc.storage.key).catch(() => {});
        await markFailed(`Magic mismatch: detected ${detected.mime}`);
        throw new AppError(
          "UNSUPPORTED_MIME",
          415,
          `Magic bytes mismatch (detected ${detected.mime}, claimed ${doc.mime})`,
        );
      }
      detectedMime = detected.mime;
    } else if (isTextish(doc.mime, doc.name)) {
      if (!looksLikeText(magic)) {
        await storage.delete(doc.storage.key).catch(() => {});
        await markFailed("Binary content claimed as text");
        throw new AppError(
          "UNSUPPORTED_MIME",
          415,
          "File content is binary but claimed as text",
        );
      }
    } else {
      await storage.delete(doc.storage.key).catch(() => {});
      await markFailed("Unrecognized file type");
      throw new AppError("UNSUPPORTED_MIME", 415, "Unrecognized file type");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err, fileId: id }, "magic byte verification failed");
    await markFailed("Verification error");
    throw new AppError("VERIFY_FAILED", 500, "File verification failed");
  }

  // 4. Sukses → 'processing'. Ingestion async akan ubah ke 'ready'.
  doc.status = "processing";
  doc.mime = detectedMime;
  doc.error = undefined;
  await doc.save();

  enqueueIngestion(doc._id.toString());

  res.json({
    id: doc._id.toString(),
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    status: doc.status,
  });
}

// ─── Meta ──────────────────────────────────────────────────────────────────

export async function getFileMeta(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();

  res.json({
    id: doc._id.toString(),
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    version: doc.version,
    origin: doc.origin,
    status: doc.status,
    error: doc.error ?? null,
    extract: doc.extract ?? null,
    summaryLine: doc.summaryLine ?? null,
    createdAt: doc.createdAt.toISOString(),
  });
}

// ─── Download ──────────────────────────────────────────────────────────────

function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
}

export async function downloadFile(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();
  if (doc.status === "pending") {
    throw new AppError("UPLOAD_INCOMPLETE", 425, "File not uploaded yet");
  }

  const storage = getStorage();
  const stream = await storage.getStream(doc.storage.key);

  const encoded = encodeURIComponent(doc.name);
  const ascii = asciiFallback(doc.name);

  res.setHeader("Content-Type", doc.mime);
  res.setHeader("Content-Length", doc.size.toString());
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  );

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((r) => res.once("drain", () => r()));
      }
    }
    res.end();
  } catch (err) {
    logger.error({ err, fileId: doc._id.toString() }, "download stream error");
    if (!res.writableEnded) res.end();
  }
}

// ─── Content preview ───────────────────────────────────────────────────────

export async function getFileContent(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();
  if (doc.status === "pending") {
    throw new AppError("UPLOAD_INCOMPLETE", 425, "File not uploaded yet");
  }

  if (!isTextish(doc.mime, doc.name)) {
    throw new AppError("NOT_TEXT", 415, "File is binary; use /download");
  }

  const storage = getStorage();
  const bytes = await storage.readBytes(
    doc.storage.key,
    MAX_CONTENT_PREVIEW_BYTES,
  );
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const truncated = doc.size > MAX_CONTENT_PREVIEW_BYTES;

  res.json({ text, truncated, size: doc.size });
}

// ─── Delete ────────────────────────────────────────────────────────────────

export async function deleteFile(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();

  try {
    await getStorage().delete(doc.storage.key);
  } catch (err) {
    logger.warn({ err, key: doc.storage.key }, "r2 delete failed");
  }

  await FileDocModel.deleteOne({ _id: doc._id });
  res.status(204).end();
}
