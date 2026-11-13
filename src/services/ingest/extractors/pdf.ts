// src/services/ingest/extractors/pdf.ts

import { extractText, getDocumentProxy } from "unpdf";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { env } from "../../../config/env.js";
import { digestImage } from "../vision.js";
import { logger } from "../../../config/logger.js";

export interface PdfExtract {
  kind: string;
  text: string;
  pages: number;
  ocrPages?: number;
}

async function rasterizePdf(buf: Buffer, maxPages: number): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "genui-pdf-"));
  try {
    const inputPath = join(dir, "in.pdf");
    const outPrefix = join(dir, "page");
    await writeFile(inputPath, buf);

    const proc = Bun.spawn(
      [
        "pdftoppm",
        "-r",
        "110",
        "-png",
        "-f",
        "1",
        "-l",
        String(maxPages),
        inputPath,
        outPrefix,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`pdftoppm exit ${exit}: ${err.slice(0, 200)}`);
    }

    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    return await Promise.all(files.map((f) => readFile(join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractPdf(buf: Buffer): Promise<PdfExtract> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const fullText = Array.isArray(text) ? text.join("\n\n") : text;

  const avgCharsPerPage = totalPages > 0 ? fullText.length / totalPages : 0;
  if (avgCharsPerPage >= 100) {
    return { kind: "pdf", text: fullText, pages: totalPages };
  }

  // Scan PDF — OCR pakai Vision per halaman.
  logger.info({ pages: totalPages }, "pdf looks scanned; running OCR");
  const maxPages = Math.min(totalPages, env.MAX_OCR_PAGES);
  const images = await rasterizePdf(buf, maxPages);
  const ocrTexts: string[] = [];

  // Paralel 2 sesuai PRD §2.
  const CONCURRENCY = 2;
  for (let i = 0; i < images.length; i += CONCURRENCY) {
    const batch = images.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((img) => digestImage(img)));
    for (let j = 0; j < results.length; j++) {
      ocrTexts.push(
        `## Halaman ${i + j + 1}\n\n${results[j].ocrText || results[j].summary}`,
      );
    }
  }

  return {
    kind: "pdf-scan",
    text: ocrTexts.join("\n\n"),
    pages: totalPages,
    ocrPages: images.length,
  };
}
