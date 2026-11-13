// src/services/tools/files.ts

import { z } from "zod";
import { FileDocModel } from "../../models/FileDoc.js";
import { registerTool, okResult, errorResult } from "./registry.js";
import { saveGenerated, previewForMime, guessMime } from "./saveGenerated.js";

const MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024;

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

    if (buf.length > MAX_GENERATED_FILE_BYTES) {
      return errorResult("FILE_TOO_LARGE", "File exceeds 10MB");
    }

    const saved = await saveGenerated({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name: a.name,
      mime,
      buf,
    });

    const present = a.present !== false;
    if (present) {
      ctx.emitBlock({
        type: "file",
        fileId: saved._id.toString(),
        name: saved.name,
        mime: saved.mime,
        size: saved.size,
        version: saved.version,
        preview: previewForMime(saved.mime, saved.name),
      });
    }

    return okResult({
      fileId: saved._id.toString(),
      name: saved.name,
      version: saved.version,
      size: saved.size,
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
