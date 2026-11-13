// src/services/tools/terminal/commands/list_files.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";
import { FileDocModel } from "../../../../models/FileDoc.js";

const ListFilesArgs = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

registerCommand({
  name: "list_files",
  description:
    'Daftar file di sesi ini (fileId, nama, mime, ukuran, versi, status). Args: {} atau {"limit":20}.',
  argsSchema: ListFilesArgs,
  timeoutMs: 2000,
  async run(args, ctx) {
    const a = ListFilesArgs.parse(args);
    const docs = await FileDocModel.find({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      status: { $in: ["ready", "processing"] },
    })
      .sort({ createdAt: -1 })
      .limit(a.limit ?? 20)
      .lean();

    return {
      ok: true,
      data: {
        files: docs.map((d) => ({
          fileId: d._id.toString(),
          name: d.name,
          mime: d.mime,
          size: d.size,
          version: d.version,
          status: d.status,
        })),
      },
    };
  },
});
