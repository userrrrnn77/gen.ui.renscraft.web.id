// src/services/tools/saveGenerated.ts
import { Types } from "mongoose";
import { FileDocModel, type FileIndexStatus } from "../../models/FileDoc.js";
import { ChunkModel } from "../../models/Chunk.js";
import { getStorage, pickPrefix } from "../../storage/index.js";
import { chunkText } from "../ingest/chunker.js";
import { embedAndStoreChunks } from "../ingest/embedder.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
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
  "css",
  "html",
  "xml",
  "yaml",
  "yml",
  "json",
  "toml",
  "ini",
]);

export function sha256Hex(buf: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

export function previewForMime(
  mime: string,
  name: string,
): "code" | "text" | "image" | "pdf" | "none" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (CODE_EXTS.has(e)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "none";
}

export function guessMime(name: string): string {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    ts: "text/x-typescript",
    tsx: "text/x-typescript",
    js: "text/javascript",
    jsx: "text/javascript",
    py: "text/x-python",
    rb: "text/x-ruby",
    go: "text/x-go",
    rs: "text/x-rust",
    java: "text/x-java",
    c: "text/x-c",
    h: "text/x-c",
    cpp: "text/x-c++",
    sh: "text/x-shellscript",
    sql: "text/x-sql",
    css: "text/css",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };
  return map[e] ?? "text/plain";
}

export function isTextish(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  const e = (name.split(".").pop() ?? "").toLowerCase();
  return CODE_EXTS.has(e);
}

export interface SaveGeneratedInput {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  name: string;
  mime: string;
  buf: Buffer;
  summaryLine?: string;
  doChunk?: boolean;
}

export interface SavedGenerated {
  _id: Types.ObjectId;
  name: string;
  mime: string;
  size: number;
  version: number;
}

export async function saveGenerated(
  input: SaveGeneratedInput,
): Promise<SavedGenerated> {
  const existing = await FileDocModel.findOne({
    sessionId: input.sessionId,
    userId: input.userId,
    name: input.name,
    origin: "generated",
  })
    .sort({ version: -1 })
    .lean();
  const nextVersion = existing ? existing.version + 1 : 1;
  const parentId = existing ? existing._id : null;

  const storage = getStorage();
  const prefix = pickPrefix(input.mime);
  const ref = await storage.put(
    input.buf,
    { mime: input.mime, name: input.name },
    prefix,
  );

  const shouldChunk = input.doChunk ?? isTextish(input.mime, input.name);
  const willIndex = shouldChunk && env.EMBEDDING_ENABLED;

  const doc = await FileDocModel.create({
    userId: input.userId,
    sessionId: input.sessionId,
    origin: "generated",
    name: input.name,
    mime: input.mime,
    size: input.buf.length,
    sha256: sha256Hex(input.buf),
    version: nextVersion,
    parentFileId: parentId,
    storage: ref,
    status: "ready",
    indexStatus: willIndex ? "pending" : "disabled",
  });

  let summaryLine = input.summaryLine;

  if (shouldChunk) {
    const text = input.buf.toString("utf-8");
    const chunks = chunkText(text);
    if (chunks.length > 0) {
      const inserted = await ChunkModel.insertMany(
        chunks.map((t, i) => ({
          fileId: doc._id,
          sessionId: input.sessionId,
          idx: i,
          text: t,
        })),
      );

      if (env.EMBEDDING_ENABLED) {
        const fileId = doc._id;
        void embedAndStoreChunks(
          inserted.map((c) => ({ _id: c._id, text: c.text })),
        )
          .then(async (result) => {
            const finalStatus: FileIndexStatus =
              result.embedded === 0 ? "failed" : "ready";
            await FileDocModel.updateOne(
              { _id: fileId },
              { $set: { indexStatus: finalStatus } },
            );
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, fileId: fileId.toString() },
              "saveGenerated embedding failed",
            );
          });
      }
    }
    if (summaryLine === undefined) {
      const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
      summaryLine = firstLine.slice(0, 120);
    }
  }

  if (summaryLine !== undefined) {
    doc.summaryLine = summaryLine;
    await doc.save();
  }

  return {
    _id: doc._id,
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    version: doc.version,
  };
}
