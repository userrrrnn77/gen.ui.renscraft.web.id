// src/chat/blockEmitter.ts

import type { Block } from "../blocks/schemas.js";

export type SseSend = (event: string, data: unknown) => void;

/**
 * Mengelola penomoran blok lintas iterasi agent loop.
 * Satu turn = satu urutan blok monoton.
 *
 * Index parser (`FenceParser`) dan emitter sengaja DIPISAH:
 * parser reset tiap iterasi (index mulai 0), emitter counter monoton
 * sepanjang turn. Karena hanya satu blok aktif pada satu waktu,
 * emitter cukup track `currentIndex` dan abaikan index dari parser.
 */
export class BlockEmitter {
  private nextIndex = 0;
  private currentIndex: number | null = null;
  private accum: Block[] = [];

  constructor(private readonly send: SseSend) {}

  start(block: Block): number {
    const idx = this.nextIndex++;
    this.currentIndex = idx;
    this.send("block.start", { index: idx, block });
    return idx;
  }

  delta(_parserIndex: number, delta: string): void {
    if (this.currentIndex === null) return;
    this.send("block.delta", { index: this.currentIndex, delta });
  }

  end(_parserIndex: number, block: Block): void {
    if (this.currentIndex === null) return;
    this.send("block.end", { index: this.currentIndex, block });
    this.accum.push(block);
    this.currentIndex = null;
  }

  emitAtomic(block: Block): void {
    const idx = this.start(block);
    this.end(idx, block);
  }

  get blocks(): Block[] {
    return this.accum;
  }
}
