// src/ingest/vision.ts

import sharp from "sharp";
import { chat } from "../llm/nvidiaClient.js";
import { env } from "../config/env.js";

export interface ImageDigest {
  summary: string;
  ocrText: string;
  json: unknown;
}

const DIGEST_PROMPT = `Analisis gambar ini. Balas HANYA dengan JSON valid tanpa markdown, dengan struktur:
{"summary": "ringkasan singkat isi gambar (1-3 kalimat)", "ocr_text": "semua teks yang terlihat, atau kosong", "elements": ["objek utama"], "chart_data": null atau data jika gambar berisi chart, "language": "kode bahasa teks dominan atau null", "notes": "catatan relevan atau null"}`;

async function normalize(
  buf: Buffer,
): Promise<{ dataUrl: string; mime: string }> {
  const img = sharp(buf, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const maxSide = 2048;
  const longSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  const resized =
    longSide > maxSide
      ? img.resize({
          width: meta.width! >= meta.height! ? maxSide : undefined,
          height: meta.height! > meta.width! ? maxSide : undefined,
          fit: "inside",
        })
      : img;
  const out = await resized.png().toBuffer();
  return {
    dataUrl: `data:image/png;base64,${out.toString("base64")}`,
    mime: "image/png",
  };
}

function tolerantParse(raw: string): { parsed: unknown; raw: string } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return { parsed: JSON.parse(cleaned), raw };
  } catch {
    return { parsed: null, raw };
  }
}

export async function digestImage(buf: Buffer): Promise<ImageDigest> {
  const { dataUrl } = await normalize(buf);
  const res = await chat({
    model: env.MODEL_VISION,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: DIGEST_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 1500,
    temperature: 0.2,
  });

  const raw = res.choices[0]?.message.content ?? "";
  const { parsed } = tolerantParse(raw);

  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    return {
      summary: typeof o.summary === "string" ? o.summary : raw.slice(0, 500),
      ocrText: typeof o.ocr_text === "string" ? o.ocr_text : "",
      json: parsed,
    };
  }
  return { summary: raw.slice(0, 800), ocrText: "", json: null };
}

export async function visionQuery(
  buf: Buffer,
  question: string,
): Promise<string> {
  const { dataUrl } = await normalize(buf);
  const res = await chat({
    model: env.MODEL_VISION,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 1500,
    temperature: 0.2,
  });
  return (res.choices[0]?.message.content ?? "").trim();
}
