// src/services/tools/terminal/commands/file_hash.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";

const FileHashArgs = z.object({
  fileId: z.string(),
  algorithm: z.enum(["sha256", "md5"]).optional(),
});

registerCommand({
  name: "file_hash",
  description:
    'Hitung hash file (sha256 atau md5). Args: {"fileId":"...","algorithm":"sha256"}.',
  argsSchema: FileHashArgs,
  timeoutMs: 5000,
  async run(args, ctx) {
    const a = FileHashArgs.parse(args);
    const bytes = await ctx.readFileBytes(a.fileId);
    const algorithm = a.algorithm ?? "sha256";
    const hash = new Bun.CryptoHasher(algorithm).update(bytes).digest("hex");
    return { ok: true, data: { algorithm, hash, size: bytes.length } };
  },
});
