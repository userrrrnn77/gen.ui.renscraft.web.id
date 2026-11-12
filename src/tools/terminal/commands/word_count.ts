// src/tools/terminal/commands/word_count.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";

const WordCountArgs = z.object({
  fileId: z.string().optional(),
  text: z.string().max(200_000).optional(),
});

registerCommand({
  name: "word_count",
  description:
    'Hitung jumlah karakter, kata, dan baris. Args: {"fileId":"..."} atau {"text":"..."}.',
  argsSchema: WordCountArgs,
  timeoutMs: 2000,
  async run(args, ctx) {
    const a = WordCountArgs.parse(args);
    if (!a.fileId && !a.text) {
      return {
        ok: false,
        error: "INVALID_ARGS",
        data: "fileId atau text wajib salah satu",
      };
    }
    const raw = a.fileId ? await ctx.readFileText(a.fileId) : (a.text ?? "");
    const words = raw.split(/\s+/).filter((w) => w.length > 0).length;
    const lines = raw.length === 0 ? 0 : raw.split("\n").length;
    return { ok: true, data: { chars: raw.length, words, lines } };
  },
});
