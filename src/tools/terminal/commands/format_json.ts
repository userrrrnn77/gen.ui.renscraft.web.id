// src/tools/terminal/commands/format_json.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";

const FormatJsonArgs = z.object({
  fileId: z.string().optional(),
  text: z.string().max(100_000).optional(),
  indent: z.number().int().min(0).max(8).optional(),
});

const MAX_OUTPUT_CHARS = 4000;

registerCommand({
  name: "format_json",
  description:
    'Pretty-print JSON. Args: {"fileId":"..."} atau {"text":"..."}; indent opsional (default 2).',
  argsSchema: FormatJsonArgs,
  timeoutMs: 2000,
  async run(args, ctx) {
    const a = FormatJsonArgs.parse(args);
    if (!a.fileId && !a.text) {
      return {
        ok: false,
        error: "INVALID_ARGS",
        data: "fileId atau text wajib salah satu",
      };
    }
    const raw = a.fileId ? await ctx.readFileText(a.fileId) : (a.text ?? "");
    try {
      const parsed: unknown = JSON.parse(raw);
      const formatted = JSON.stringify(parsed, null, a.indent ?? 2);
      const truncated = formatted.length > MAX_OUTPUT_CHARS;
      return {
        ok: true,
        data: {
          formatted: truncated
            ? formatted.slice(0, MAX_OUTPUT_CHARS)
            : formatted,
          length: formatted.length,
          truncated,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: "INVALID_JSON",
        data: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
