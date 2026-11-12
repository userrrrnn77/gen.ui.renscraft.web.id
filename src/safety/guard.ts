// src/safety/guard.ts

import { chat } from "../llm/nvidiaClient.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export interface SafetyInput {
  text: string;
  attachmentDigests?: Array<{ summary?: string; ocrText?: string }>;
}

export interface SafetyResult {
  safe: boolean;
  category?: string;
}

const SAFETY_PROMPT = `Analyze the user input below for policy violations. 
Categories to flag as unsafe: explicit sexual content, graphic violence, hate speech, harassment, illegal activity instructions (weapons, drugs, actual hacking/malware creation), self-harm.

IMPORTANT EXCEPTION: Requests for programming help, writing code (CRUD, APIs, frontend, backend), software architecture, database design (MongoDB, SQL, Express, etc), or technical tutorials are 100% SAFE and MUST be classified as safe. Do not flag technical jargon as hacking.

Respond with a single word on the first line: "safe" or "unsafe". If unsafe, add the violated category code on the second line.

User input:
`;

export async function checkSafety(input: SafetyInput): Promise<SafetyResult> {
  if (!env.SAFETY_ENABLED) return { safe: true };

  const digestsText = (input.attachmentDigests ?? [])
    .map((d) => [d.summary ?? "", d.ocrText ?? ""].join("\n"))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");

  const combined = [input.text, digestsText]
    .filter((s) => s.trim().length > 0)
    .join("\n\n---\n\n")
    .slice(0, 4000);

  try {
    const res = await chat({
      model: env.MODEL_SAFETY,
      messages: [{ role: "user", content: SAFETY_PROMPT + combined }],
      temperature: 0,
      max_tokens: 20,
    });
    const out = (res.choices[0]?.message.content ?? "").trim().toLowerCase();

    // Cek "unsafe" dulu — string "unsafe" mengandung substring "safe",
    // jadi urutan pengecekan ini krusial. Jangan dibalik.
    if (out.includes("unsafe")) {
      const category = out.split("\n")[1]?.trim() || undefined;
      logger.warn(
        { category, preview: out.slice(0, 100) },
        "safety: input flagged unsafe",
      );
      return {
        safe: false,
        ...(category !== undefined ? { category } : {}),
      };
    }
    if (out.includes("safe")) {
      return { safe: true };
    }

    logger.warn(
      { raw: out.slice(0, 200) },
      "safety: ambiguous output, failing open",
    );
    return { safe: true };
  } catch (err) {
    logger.warn({ err }, "safety check failed; failing open");
    return { safe: true };
  }
}
