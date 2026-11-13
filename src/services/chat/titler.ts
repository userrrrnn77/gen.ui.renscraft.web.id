// src/services/chat/titler.ts

import { chat, type ChatMessage } from "../llm/nvidiaClient.js";
import { SUMMARY_MODEL } from "../../config/env.js";
import { SessionModel } from "../../models/Session.js";
import { logger } from "../../config/logger.js";

const TITLE_PROMPT = `Buat judul percakapan yang sangat singkat (maksimal 60 karakter, tanpa tanda kutip, tanpa titik di akhir, bahasa sama dengan user). Balas HANYA judulnya.

Percakapan:
`;

// Reasoning model (MODEL_SUMMARY default = lightning) butuh budget token
// untuk reasoning dulu sebelum menulis content. 200 terlalu kecil — sudah
// terbukti contentLen=0 finishReason="length". 3000 cukup untuk
// reasoning ~1500-2000 token + judul singkat.
const TITLE_MAX_TOKENS = 3000;
const TITLE_TIMEOUT_MS = 90_000;

export async function generateTitle(
  sessionId: string,
  recentMessages: ChatMessage[],
): Promise<string | null> {
  const body =
    TITLE_PROMPT +
    recentMessages
      .map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`)
      .join("\n");

  try {
    const res = await chat(
      {
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: body }],
        max_tokens: TITLE_MAX_TOKENS,
        temperature: 0.3,
      },
      undefined,
      TITLE_TIMEOUT_MS,
    );
    const msg = res.choices[0]?.message;
    const raw = (msg?.content ?? "").trim();
    if (!raw) {
      logger.warn(
        {
          sessionId,
          model: SUMMARY_MODEL,
          finishReason: res.choices[0]?.finish_reason ?? null,
          reasoningLen: (msg?.reasoning_content ?? "").length,
        },
        "title generation returned empty content",
      );
      return null;
    }
    const title = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!title || title.length > 100) return null;

    await SessionModel.updateOne(
      { _id: sessionId, titleAuto: true },
      { $set: { title, titleAuto: false } },
    );
    return title;
  } catch (err) {
    logger.warn({ err }, "title generation failed");
    return null;
  }
}
