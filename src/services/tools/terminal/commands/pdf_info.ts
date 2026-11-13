// src/services/tools/terminal/commands/pdf_info.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";
import { spawnBounded } from "../runner.js";

const PdfInfoArgs = z.object({
  fileId: z.string(),
});

registerCommand({
  name: "pdf_info",
  description:
    'Ambil metadata PDF: jumlah halaman, ukuran, judul, produsen. Args: {"fileId":"..."}.',
  argsSchema: PdfInfoArgs,
  timeoutMs: 5000,
  async run(args, ctx) {
    const a = PdfInfoArgs.parse(args);
    const filename = await ctx.materializeFile(a.fileId);

    const result = await spawnBounded("pdfinfo", [filename], {
      cwd: ctx.workdir,
      timeoutMs: 4000,
    });

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: "PDFINFO_FAILED",
        data: result.stderr.slice(0, 300) || `exit ${result.exitCode}`,
        exitCode: result.exitCode,
      };
    }

    const info: Record<string, string> = {};
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) info[m[1].trim()] = m[2].trim();
    }
    return { ok: true, data: info, exitCode: 0 };
  },
});
