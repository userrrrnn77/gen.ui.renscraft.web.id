// src/services/ingest/extractors/index.ts

import { extractPlainText } from "./text.js";
import {
  extractCsv,
  extractDocx,
  extractOfficeText,
  extractXls,
  extractXlsx,
} from "./office.js";
import { extractPdf } from "./pdf.js";
import { extractImage } from "./image.js";

export interface ExtractResult {
  kind: string;
  text: string;
  pages?: number;
  sheets?: number;
  truncated?: boolean;
  ocrPages?: number;
  digest?: { summary: string; ocrText: string; json: unknown };
}

const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
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
  "log",
  "ini",
  "env",
  "toml",
]);

export async function extract(
  buf: Buffer,
  name: string,
  mime: string,
): Promise<ExtractResult> {
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  if (mime.startsWith("image/")) {
    const r = await extractImage(buf);
    return { kind: r.kind, text: r.text, digest: r.digest };
  }

  if (mime === "application/pdf" || ext === "pdf") {
    const r = await extractPdf(buf);
    return {
      kind: r.kind,
      text: r.text,
      pages: r.pages,
      ...(r.ocrPages !== undefined ? { ocrPages: r.ocrPages } : {}),
    };
  }

  if (ext === "docx") return await extractDocx(buf);
  if (ext === "xlsx") return await extractXlsx(buf);
  if (ext === "xls") return extractXls(buf);
  if (ext === "csv") return extractCsv(buf);
  if (["pptx", "odt", "odp", "rtf", "ppt"].includes(ext)) {
    return await extractOfficeText(buf);
  }

  if (TEXT_EXTS.has(ext) || mime.startsWith("text/")) {
    return extractPlainText(buf, name);
  }

  throw new Error(`Unsupported file type: ${mime || ext}`);
}
