// src/tools/files.ts

import { z } from "zod";
import { FileDocModel } from "../models/FileDoc.js";
import { registerTool, okResult, errorResult } from "./registry.js";
import { getStorage, pickPrefix } from "../storage/index.js";
import { chunkText } from "../ingest/chunker.js";
import { ChunkModel } from "../models/Chunk.js";

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

function sha256Hex(buf: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

function previewForMime(
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

function guessMime(name: string): string {
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

function isTextish(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  const e = (name.split(".").pop() ?? "").toLowerCase();
  return CODE_EXTS.has(e);
}

// ─── create_file ──────────────────────────────────────────────────────────

const CreateFileSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string(),
  mime: z.string().optional(),
  present: z.boolean().optional(),
});

registerTool({
  name: "create_file",
  kind: "file",
  description:
    "Buat atau perbarui file di sesi ini. Jika nama file sudah ada, otomatis jadi versi baru. Set present=false jika tidak perlu tampilkan kartu.",
  schema: CreateFileSchema,
  async run(args, ctx) {
    const a = CreateFileSchema.parse(args);
    const mime = a.mime ?? guessMime(a.name);
    const buf = Buffer.from(a.content, "utf-8");

    if (buf.length > 10 * 1024 * 1024) {
      return errorResult("FILE_TOO_LARGE", "File exceeds 10MB");
    }

    const existing = await FileDocModel.findOne({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      name: a.name,
      origin: "generated",
    })
      .sort({ version: -1 })
      .lean();

    const nextVersion = existing ? existing.version + 1 : 1;
    const parentId = existing ? existing._id : null;

    const storage = getStorage();
    const prefix = pickPrefix(mime);
    const ref = await storage.put(buf, { mime, name: a.name }, prefix);

    const doc = await FileDocModel.create({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      origin: "generated",
      name: a.name,
      mime,
      size: buf.length,
      sha256: sha256Hex(buf),
      version: nextVersion,
      parentFileId: parentId,
      storage: ref,
      status: "ready",
    });

    // Chunking + summaryLine untuk file teks/kode — supaya
    // search_attachment bisa menemukan isi file yang dibuat AI.
    if (isTextish(doc.mime, doc.name)) {
      const chunks = chunkText(a.content);
      if (chunks.length > 0) {
        await ChunkModel.insertMany(
          chunks.map((t, i) => ({
            fileId: doc._id,
            sessionId: ctx.sessionId,
            idx: i,
            text: t,
          })),
        );
      }
      const firstLine =
        a.content.split("\n").find((l) => l.trim().length > 0) ?? "";
      doc.summaryLine = firstLine.slice(0, 120);
      await doc.save();
    }

    const present = a.present !== false;
    if (present) {
      ctx.emitBlock({
        type: "file",
        fileId: doc._id.toString(),
        name: doc.name,
        mime: doc.mime,
        size: doc.size,
        version: doc.version,
        preview: previewForMime(doc.mime, doc.name),
      });
    }

    return okResult({
      fileId: doc._id.toString(),
      name: doc.name,
      version: doc.version,
      size: doc.size,
      presented: present,
    });
  },
});

// ─── present_files ─────────────────────────────────────────────────────────

const PresentFilesSchema = z.object({
  fileIds: z.array(z.string()).min(1).max(10),
  note: z.string().optional(),
});

registerTool({
  name: "present_files",
  kind: "file",
  description:
    "Tampilkan kartu file yang sudah ada di sesi ini. Gunakan saat user minta file lama atau ingin menampilkan ulang.",
  schema: PresentFilesSchema,
  async run(args, ctx) {
    const a = PresentFilesSchema.parse(args);
    const ids = a.fileIds.filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (ids.length === 0) {
      return errorResult("INVALID_IDS", "No valid fileId provided");
    }

    const docs = await FileDocModel.find({
      _id: { $in: ids },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    }).lean();

    if (docs.length === 0) {
      return errorResult("NOT_FOUND", "No matching files in this session");
    }

    for (const doc of docs) {
      ctx.emitBlock({
        type: "file",
        fileId: doc._id.toString(),
        name: doc.name,
        mime: doc.mime,
        size: doc.size,
        version: doc.version,
        preview: previewForMime(doc.mime, doc.name),
        ...(a.note !== undefined ? { note: a.note } : {}),
      });
    }

    return okResult({ presented: docs.length });
  },
});
