// REPLACE: full file (TARGET/OVERLAP dari env + separator "\n" overlap)
// src/services/ingest/chunker.ts
import { env } from "../../config/env.js";

const TARGET = env.CHUNK_TARGET_CHARS;
const OVERLAP = env.CHUNK_OVERLAP_CHARS;

/**
 * Pecah teks jadi chunk ~TARGET char dengan overlap OVERLAP, utamakan
 * batas paragraf/heading. Heading markdown (#, ##) diperlakukan sebagai
 * titik potong tambahan.
 */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.length <= TARGET) return clean ? [clean] : [];

  const blocks: string[] = [];
  let buf = "";
  // Split per paragraf/heading.
  for (const part of clean.split(/\n{2,}|\n(?=#{1,6}\s)/)) {
    if (!part) continue;
    if (buf.length + part.length + 2 <= TARGET) {
      buf = buf ? `${buf}\n\n${part}` : part;
    } else {
      if (buf) blocks.push(buf);
      if (part.length > TARGET) {
        // Potong keras per TARGET dengan overlap.
        let i = 0;
        while (i < part.length) {
          blocks.push(part.slice(i, i + TARGET));
          i += TARGET - OVERLAP;
        }
        buf = "";
      } else {
        buf = part;
      }
    }
  }
  if (buf) blocks.push(buf);

  // Beri overlap antar blok yang berdampingan (dengan pemisah "\n").
  if (blocks.length <= 1) return blocks;
  const out: string[] = [blocks[0]];
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const tail = prev.length > OVERLAP ? prev.slice(-OVERLAP) : prev;
    out.push(`${tail}\n${blocks[i]}`);
  }
  return out;
}
