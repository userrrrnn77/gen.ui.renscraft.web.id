// src/services/ingest/extractors/image.ts

import { digestImage } from "../vision.js";

export interface ImageExtract {
  kind: string;
  text: string;
  digest: { summary: string; ocrText: string; json: unknown };
}

export async function extractImage(buf: Buffer): Promise<ImageExtract> {
  const digest = await digestImage(buf);
  return { kind: "image", text: "", digest };
}
