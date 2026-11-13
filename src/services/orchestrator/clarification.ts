// src/services/orchestrator/clarification.ts
import type { Block } from "../blocks/schemas.js";

export interface ClarificationOption {
  label: string;
  value?: string;
}

export interface ClarificationQuestion {
  question: string;
  multi: boolean;
  options: ClarificationOption[];
}

export interface DetectContext {
  text: string;
  attachmentIds: string[];
  files: Array<{
    _id: unknown;
    name: string;
    status: string;
    origin: string;
    createdAt: Date;
  }>;
  history: Array<{
    role: string;
    blocks: Block[];
  }>;
  enabled: boolean;
}

const R1_PATTERN =
  /\b(file|dokumen|lampiran|pdf|gambar|foto|attachment|document)\s+(ini|itu|tadi|tersebut|this|that)\b/i;
const R2_PATTERN =
  /^(tolong\s+)?(buat(kan)?|bikin(kan)?|generate|create|make)\s+(sebuah\s+|a\s+)?(laporan|report|dokumen|document|file|ringkasan)\s*\.?$/i;
const R3_VERB = /\b(ubah|edit|revisi|perbaiki|update|ganti)\b/i;
const R3_NOUN = /\b(file|dokumen)\b/i;

function mentionsFile(text: string, names: string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((n) => n.length > 0 && lower.includes(n.toLowerCase()));
}

function topRecent<T extends { createdAt: Date }>(items: T[], n: number): T[] {
  return [...items]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, n);
}

/**
 * Rule-based klarifikasi. Murni (tanpa I/O). Mengembalikan maksimal satu
 * pertanyaan. Semua teks pertanyaan Bahasa Indonesia.
 */
export function detectClarification(
  ctx: DetectContext,
): ClarificationQuestion | null {
  if (!ctx.enabled) return null;
  if (ctx.text.trim().length === 0) return null;
  if (ctx.text.length > 200) return null;

  // Guard: pesan assistant terakhir berisi block choices → user sedang menjawab
  const lastAssistant = [...ctx.history]
    .reverse()
    .find((h) => h.role === "assistant");
  if (lastAssistant?.blocks.some((b) => b.type === "choices")) return null;

  const readyFiles = ctx.files.filter((f) => f.status === "ready");

  // R1 — rujukan file ambigu
  if (
    R1_PATTERN.test(ctx.text) &&
    ctx.attachmentIds.length === 0 &&
    readyFiles.length >= 2 &&
    !mentionsFile(
      ctx.text,
      readyFiles.map((f) => f.name),
    )
  ) {
    const recent = topRecent(readyFiles, 5);
    return {
      question: "File mana yang kamu maksud?",
      multi: false,
      options: [
        ...recent.map((f) => ({ label: f.name, value: String(f._id) })),
        { label: "Semua file" },
      ],
    };
  }

  // R2 — permintaan dokumen tanpa format
  if (R2_PATTERN.test(ctx.text.trim())) {
    return {
      question: "Format apa yang kamu mau?",
      multi: false,
      options: [
        { label: "PDF", value: "pdf" },
        { label: "File Markdown (.md)", value: "markdown" },
        { label: "Tampilkan di chat", value: "chat" },
      ],
    };
  }

  // R3 — edit file tanpa target
  if (R3_VERB.test(ctx.text) && R3_NOUN.test(ctx.text)) {
    const generated = ctx.files.filter(
      (f) => f.origin === "generated" && f.status === "ready",
    );
    if (
      generated.length >= 2 &&
      !mentionsFile(
        ctx.text,
        generated.map((f) => f.name),
      )
    ) {
      const recent = topRecent(generated, 5);
      return {
        question: "File mana yang mau diubah?",
        multi: false,
        options: recent.map((f) => ({ label: f.name, value: String(f._id) })),
      };
    }
  }

  return null;
}
