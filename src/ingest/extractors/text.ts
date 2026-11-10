// src/ingest/extractors/text.ts

import sanitizeHtml from "sanitize-html";

export interface TextExtract {
  kind: string;
  text: string;
}

export function extractPlainText(buf: Buffer, name: string): TextExtract {
  const raw = buf.toString("utf-8");
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  if (ext === "html" || ext === "htm") {
    const stripped = sanitizeHtml(raw, {
      allowedTags: [],
      allowedAttributes: {},
    });
    return { kind: "html", text: stripped.replace(/\n{3,}/g, "\n\n").trim() };
  }

  return { kind: ext || "text", text: raw };
}
