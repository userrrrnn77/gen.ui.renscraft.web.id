// src/chat/titler.ts

import { chat, type ChatMessage } from "../llm/nvidiaClient.js";
import { env } from "../config/env.js";
import { SessionModel } from "../models/Session.js";
import { logger } from "../config/logger.js";

const TITLE_PROMPT = `Buat judul percakapan yang sangat singkat (maksimal 60 karakter, tanpa tanda kutip, tanpa titik di akhir, bahasa sama dengan user). Balas HANYA judulnya.

Percakapan:
`;

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
    const res = await chat({
      model: env.MODEL_FAST,
      messages: [{ role: "user", content: body }],
      max_tokens: 40,
      temperature: 0.3,
    });
    const raw = res.choices[0]?.message.content ?? "";
    const title = raw
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
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
