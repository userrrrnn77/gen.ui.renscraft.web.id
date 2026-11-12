// src/tools/pdf.ts

import { z } from "zod";
import { registerTool, errorResult, okResult } from "./registry.js";
import { markdownToHtml, sanitize, wrapHtml } from "../pdf/template.js";
import { getPdfEngine } from "../pdf/engine.js";
import { saveGenerated, previewForMime } from "./saveGenerated.js";

const GeneratePdfSchema = z.object({
  filename: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  markdown: z.string().optional(),
  html: z.string().optional(),
  present: z.boolean().optional(),
});

function ensurePdfName(name: string): string {
  const trimmed = name.trim() || "document.pdf";
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
}

registerTool({
  name: "generate_pdf",
  kind: "file",
  description:
    "Buat file PDF (A4) dari markdown atau HTML. Gunakan untuk permintaan 'buatkan laporan PDF' / 'ekspor ke PDF'. Jangan menulis PDF sebagai kode atau teks.",
  schema: GeneratePdfSchema,
  async run(args, ctx) {
    const a = GeneratePdfSchema.parse(args);

    const hasMd = typeof a.markdown === "string";
    const hasHtml = typeof a.html === "string";
    if (hasMd === hasHtml) {
      return errorResult(
        "INVALID_ARGS",
        "Isi tepat salah satu: markdown atau html (tidak boleh dua-duanya atau kosong).",
      );
    }

    const bodyHtml = hasMd ? markdownToHtml(a.markdown ?? "") : (a.html ?? "");

    const sanitized = sanitize(bodyHtml);
    const titleTrimmed = a.title?.trim();
    const fullHtml = wrapHtml({
      bodyHtml: sanitized,
      ...(titleTrimmed ? { title: titleTrimmed } : {}),
    });

    let pdfBuf: Buffer;
    try {
      pdfBuf = await getPdfEngine().render(fullHtml);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(
        "PDF_ENGINE_UNAVAILABLE",
        `Render PDF gagal: ${msg}. Pastikan Chromium terpasang: bunx playwright install chromium --with-deps`,
      );
    }

    const name = ensurePdfName(a.filename);
    const summaryLine = titleTrimmed ? titleTrimmed : name;

    const saved = await saveGenerated({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name,
      mime: "application/pdf",
      buf: pdfBuf,
      summaryLine,
      doChunk: false,
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
