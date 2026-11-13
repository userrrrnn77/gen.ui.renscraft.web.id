// src/services/pdf/template.ts

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const DEFAULT_CSS = `
@page { size: A4; margin: 20mm; }
* { box-sizing: border-box; }
body {
  font-family: 'Noto Sans', 'Segoe UI', Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #1f2328;
  margin: 0;
}
h1, h2, h3, h4, h5, h6 {
  page-break-after: avoid;
  break-after: avoid;
  margin: 1.2em 0 0.5em;
  line-height: 1.25;
}
h1 { font-size: 20pt; }
h2 { font-size: 16pt; }
h3 { font-size: 13pt; }
h4, h5, h6 { font-size: 11pt; }
p { margin: 0 0 0.8em; }
ul, ol { margin: 0 0 0.8em 1.4em; padding: 0; }
li { margin: 0.2em 0; }
table {
  table-layout: fixed;
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 10pt;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
th, td {
  border: 1px solid #c9c9c9;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
  word-break: break-word;
}
th { background: #f3f4f6; }
tr, pre, img {
  page-break-inside: avoid;
  break-inside: avoid;
}
pre {
  background: #f6f8fa;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0.8em 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 9.5pt;
  line-height: 1.4;
}
code {
  font-family: 'Courier New', 'Consolas', monospace;
  font-size: 0.95em;
}
pre code { font-size: inherit; }
img { max-width: 100%; height: auto; }
blockquote {
  border-left: 3px solid #d0d7de;
  margin: 0.8em 0;
  padding: 0.2em 0.8em;
  color: #57606a;
}
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.2em 0; }
`;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
    "blockquote",
    "pre",
    "code",
    "kbd",
    "samp",
    "var",
    "div",
    "span",
    "section",
    "article",
    "header",
    "footer",
    "img",
    "figure",
    "figcaption",
    "sub",
    "sup",
    "small",
  ],
  allowedAttributes: {
    "*": ["style", "class"],
    img: ["src/services", "alt", "width", "height"],
    th: ["colspan", "rowspan", "style"],
    td: ["colspan", "rowspan", "style"],
    col: ["span", "style"],
    colgroup: ["span", "style"],
  },
  allowedSchemes: ["data"],
  // tag di luar allowedTags dibuang, teks di dalamnya dipertahankan.
  disallowedTagsMode: "discard",
};

export function markdownToHtml(md: string): string {
  const result = marked.parse(md, { async: false, gfm: true });
  return typeof result === "string" ? result : "";
}

export function sanitize(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

export interface WrapOptions {
  title?: string;
  bodyHtml: string;
}

export function wrapHtml(opts: WrapOptions): string {
  const title = opts.title
    ? `<title>${escapeHtml(opts.title)}</title>`
    : "<title>Document</title>";
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
${title}
<style>${DEFAULT_CSS}</style>
</head>
<body>
${opts.bodyHtml}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
