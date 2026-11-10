// src/llm/fenceParser.ts

import type { Block } from "../blocks/schemas.js";

export interface FenceCallbacks {
  start: (index: number, block: Block) => void;
  delta: (index: number, delta: string) => void;
  end: (index: number, block: Block) => void;
}

function parseInfoString(info: string): {
  language: string;
  filename?: string;
} {
  const parts = info.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { language: "text" };
  const language = parts[0].toLowerCase();
  let filename: string | undefined;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("filename=")) {
      filename = p.slice("filename=".length).replace(/^["']|["']$/g, "");
    }
  }
  return filename !== undefined ? { language, filename } : { language };
}

/**
 * Parser markdown fence stateful. Menerima content delta dari stream
 * model dan memancarkan blok text/code via callbacks.
 *
 * Batasan v1:
 * - Fence pembuka `\`\`\`` tidak wajib di awal baris (model jarang
 *   menyisipkan backtick inline di teks normal).
 * - Fence penutup HARUS di awal baris (`\n\`\`\``) diikuti newline/EOF.
 * - Kode yang isinya `\n\`\`\`` di tengah (nested markdown) akan
 *   menutup lebih cepat; model biasanya pakai fence 4-backtick
 *   untuk kasus ini — tidak di-handle v1.
 */
export class FenceParser {
  private mode: "text" | "code" = "text";
  private buffer = "";
  private blockIndex = 0;
  private currentContent = "";
  private currentInfo: { language: string; filename?: string } = {
    language: "text",
  };
  private blocks: Block[] = [];
  private blockOpen = false;

  constructor(private readonly cb: FenceCallbacks) {}

  feed(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    // Loop: proses buffer sampai mentok (butuh data lanjutan).
    while (this.mode === "text" ? this.stepText() : this.stepCode()) {
      // teruskan
    }
  }

  finish(): Block[] {
    if (this.blockOpen && this.mode === "code") {
      const closeAtEnd = this.buffer.match(/\n```[ \t]*$/);
      if (closeAtEnd) {
        const before = this.buffer.slice(0, closeAtEnd.index);
        if (before) this.emitCode(before);
        this.buffer = "";
        this.closeCodeBlock();
        return this.blocks;
      }
      if (/^```[ \t]*$/.test(this.buffer)) {
        this.buffer = "";
        this.closeCodeBlock();
        return this.blocks;
      }
    }
    if (this.buffer) {
      if (this.mode === "text") this.emitText(this.buffer);
      else this.emitCode(this.buffer);
      this.buffer = "";
    }
    if (this.blockOpen) {
      if (this.mode === "code") this.closeCodeBlock();
      else this.closeTextBlock();
    }
    return this.blocks;
  }

  // ─── state transitions ──────────────────────────────────────────────────

  /** @returns true jika ada progres dan loop boleh lanjut */
  private stepText(): boolean {
    const idx = this.buffer.indexOf("```");
    if (idx === -1) {
      // Cek backtick parsial di akhir buffer (1-2 char).
      const tail = this.buffer.match(/`{1,2}$/);
      if (tail) {
        const safe = this.buffer.slice(0, -tail[0].length);
        if (safe) this.emitText(safe);
        this.buffer = tail[0];
        return false;
      }
      if (this.buffer) {
        this.emitText(this.buffer);
        this.buffer = "";
      }
      return false;
    }

    if (idx > 0) {
      this.emitText(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx);
    }

    // Buffer sekarang diawali ```. Tunggu newline info string.
    const nl = this.buffer.indexOf("\n");
    if (nl === -1) return false;

    const info = this.buffer.slice(3, nl).trim();
    this.openCodeBlock(info);
    this.buffer = this.buffer.slice(nl + 1);
    return true;
  }

  /** @returns true jika ada progres dan loop boleh lanjut */
  private stepCode(): boolean {
    const empty = this.buffer.match(/^```[ \t]*\n/);
    if (empty) {
      this.closeCodeBlock();
      this.buffer = this.buffer.slice(empty[0].length);
      return true;
    }

    // Tunggu newline untuk memutuskan apakah ini blok kosong atau konten
    // yang kebetulan diawali ``` (mis. kode yang memuat backtick).
    if (/^```[ \t]*$/.test(this.buffer)) {
      return false;
    }

    // Fence penutup HARUS diakhiri newline (bukan buffer end), sesuai
    // CommonMark. Buffer end = "belum tahu", jangan tutup.
    const close = this.buffer.match(/\n```[ \t]*\n/);
    if (close) {
      const before = this.buffer.slice(0, close.index);
      if (before) this.emitCode(before);
      this.closeCodeBlock();
      this.buffer = this.buffer.slice(close.index! + close[0].length);
      return true;
    }

    // Kandidat penutup di akhir buffer — tahan, jangan emit sebagai kode.
    const potentialClose = this.buffer.match(/\n```[ \t]*$/);
    if (potentialClose) {
      const before = this.buffer.slice(0, potentialClose.index);
      if (before) this.emitCode(before);
      this.buffer = potentialClose[0];
      return false;
    }

    // Tahan fence parsial di akhir buffer.
    const tail = this.buffer.match(/\n`{0,2}$/);
    if (tail) {
      const safe = this.buffer.slice(0, -tail[0].length);
      if (safe) this.emitCode(safe);
      this.buffer = tail[0];
      return false;
    }

    if (this.buffer) {
      this.emitCode(this.buffer);
      this.buffer = "";
    }
    return false;
  }

  // ─── block lifecycle ────────────────────────────────────────────────────

  private emitText(str: string): void {
    if (!str) return;
    if (!this.blockOpen) {
      this.blockOpen = true;
      this.currentContent = "";
      this.cb.start(this.blockIndex, { type: "text", markdown: "" });
    }
    this.currentContent += str;
    this.cb.delta(this.blockIndex, str);
  }

  private emitCode(str: string): void {
    if (!str) return;
    if (!this.blockOpen) return; // seharusnya tidak terjadi
    this.currentContent += str;
    this.cb.delta(this.blockIndex, str);
  }

  private openCodeBlock(info: string): void {
    if (this.blockOpen) this.closeTextBlock();
    const parsed = parseInfoString(info);
    this.currentInfo = parsed;
    this.blockOpen = true;
    this.currentContent = "";
    this.mode = "code";
    this.cb.start(this.blockIndex, {
      type: "code",
      language: parsed.language,
      ...(parsed.filename !== undefined ? { filename: parsed.filename } : {}),
      content: "",
    });
  }

  private closeTextBlock(): void {
    if (!this.blockOpen) return;
    const block: Block = { type: "text", markdown: this.currentContent };
    this.cb.end(this.blockIndex, block);
    this.blocks.push(block);
    this.blockIndex++;
    this.blockOpen = false;
    this.currentContent = "";
  }

  private closeCodeBlock(): void {
    if (!this.blockOpen) return;
    const block: Block = {
      type: "code",
      language: this.currentInfo.language,
      ...(this.currentInfo.filename !== undefined
        ? { filename: this.currentInfo.filename }
        : {}),
      content: this.currentContent,
    };
    this.cb.end(this.blockIndex, block);
    this.blocks.push(block);
    this.blockIndex++;
    this.blockOpen = false;
    this.currentContent = "";
    this.currentInfo = { language: "text" };
    this.mode = "text";
  }
}
