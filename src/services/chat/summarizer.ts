// src/services/chat/summarizer.ts

import { Types } from "mongoose";
import { chat } from "../llm/nvidiaClient.js";
import { env, SUMMARY_MODEL } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { SessionModel } from "../../models/Session.js";
import { MessageModel } from "../../models/Message.js";
import { blocksToText, estimateTokens } from "./contextBuilder.js";

const MAX_MSG_CHARS = 2000;
const MAX_BATCH_TOKENS = 8000;
const SUMMARIZE_TIMEOUT_MS = 180_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 8000;
const lock = new Set<string>();

interface SummaryItem {
  id: Types.ObjectId;
  role: "user" | "assistant";
  text: string;
  t: number;
}

export async function maybeSummarize(sessionId: Types.ObjectId): Promise<void> {
  const key = sessionId.toString();
  if (lock.has(key)) {
    logger.debug({ sessionId: key }, "summarize: skipped (locked)");
    return;
  }
  lock.add(key);
  try {
    await doSummarize(sessionId);
  } catch (err) {
    logger.warn({ err, sessionId: key }, "summarize failed");
  } finally {
    lock.delete(key);
  }
}

async function callFastSummary(
  prompt: string,
  sessionId: string,
): Promise<string | null> {
  const t0 = Date.now();
  const res = await chat(
    {
      model: SUMMARY_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    },
    undefined,
    SUMMARIZE_TIMEOUT_MS,
  );
  const elapsedMs = Date.now() - t0;

  const msg = res.choices[0]?.message;
  const content = (msg?.content ?? "").trim();
  const reasoning = (msg?.reasoning_content ?? "").trim();

  logger.debug(
    {
      sessionId,
      model: SUMMARY_MODEL,
      elapsedMs,
      contentLen: content.length,
      reasoningLen: reasoning.length,
      finishReason: res.choices[0]?.finish_reason ?? null,
      rawMessage: JSON.stringify(msg ?? null).slice(0, 500),
    },
    "summarize: model response",
  );

  // Reasoning bukan jawaban. Kalau content kosong, batch ini gagal —
  // model menghabiskan budget token untuk proses berpikir tanpa
  // pernah menulis output. Jangan simpan reasoning ke summary.
  if (!content) {
    return null;
  }
  return content;
}

function buildPrompt(prevSummary: string, items: SummaryItem[]): string {
  const body = items
    .map((x) => `${x.role}: ${x.text.slice(0, MAX_MSG_CHARS)}`)
    .join("\n\n");
  return `Kamu merangkum percakapan. Jawab LANGSUNG dengan ringkasan markdown, tanpa penjelasan proses berpikir.

Gabungkan ringkasan lama dengan pesan-pesan baru di bawah ini menjadi satu ringkasan markdown (~1500 token, bahasa mengikuti percakapan). Wajib ada bagian: Tujuan user, Keputusan, Constraint, Entitas penting, Tugas terbuka, File penting (nama + fileId), Preferensi. Jangan menghilangkan info penting dari ringkasan lama.

${prevSummary ? `Ringkasan lama:\n${prevSummary}\n\n` : ""}Pesan yang diringkas:
${body}`;
}

function splitIntoBatches(items: SummaryItem[]): SummaryItem[][] {
  const batches: SummaryItem[][] = [];
  let current: SummaryItem[] = [];
  let currentTokens = 0;
  for (const item of items) {
    const effective = Math.min(item.t, Math.ceil(MAX_MSG_CHARS / 3.5));
    if (current.length > 0 && currentTokens + effective > MAX_BATCH_TOKENS) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += effective;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function doSummarize(sessionId: Types.ObjectId): Promise<void> {
  const sid = sessionId.toString();
  logger.debug({ sessionId: sid }, "summarize: start");

  const session = await SessionModel.findById(sessionId).lean();
  if (!session) {
    logger.warn({ sessionId: sid }, "summarize: session not found");
    return;
  }

  const messages = await MessageModel.find({
    sessionId,
    summarized: { $ne: true },
    role: { $in: ["user", "assistant"] },
    status: { $in: ["done", "aborted"] },
  })
    .sort({ createdAt: 1 })
    .lean();

  if (messages.length === 0) {
    logger.debug({ sessionId: sid }, "summarize: no unsummarized messages");
    return;
  }

  let total = 0;
  const items: SummaryItem[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = blocksToText(m.blocks);
    const t = estimateTokens(text);
    total += t;
    items.push({ id: m._id, role: m.role, text, t });
  }

  logger.debug(
    {
      sessionId: sid,
      messageCount: items.length,
      totalTokens: total,
      budget: env.HISTORY_TOKEN_BUDGET,
    },
    "summarize: token scan",
  );

  if (total <= env.HISTORY_TOKEN_BUDGET) {
    logger.debug({ sessionId: sid }, "summarize: under budget, skip");
    return;
  }

  const target = env.HISTORY_TOKEN_BUDGET * 0.5;
  let remaining = total;
  let cutIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (remaining <= target) break;
    remaining -= items[i].t;
    cutIdx = i;
  }
  while (cutIdx >= 0 && items[cutIdx].role !== "assistant") cutIdx--;
  if (cutIdx < 0) {
    logger.warn({ sessionId: sid }, "summarize: no cut point");
    return;
  }

  const cut = items.slice(0, cutIdx + 1);
  const lastId = cut[cut.length - 1].id;
  const batches = splitIntoBatches(cut);

  logger.debug(
    {
      sessionId: sid,
      cutCount: cut.length,
      batchCount: batches.length,
      lastId: lastId.toString(),
    },
    "summarize: cut decided",
  );

  let prevSummary = session.summary ?? "";
  let anySuccess = false;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const prompt = buildPrompt(prevSummary, batch);
    logger.debug(
      {
        sessionId: sid,
        batch: b + 1,
        of: batches.length,
        promptChars: prompt.length,
        promptTokens: estimateTokens(prompt),
      },
      "summarize: calling MODEL_FAST",
    );

    let newSummary: string | null = null;
    try {
      newSummary = await callFastSummary(prompt, sid);
    } catch (err) {
      logger.warn(
        { err, sessionId: sid, batch: b + 1 },
        "summarize: batch failed",
      );
      continue;
    }

    if (!newSummary) {
      logger.warn(
        { sessionId: sid, batch: b + 1 },
        "summarize: empty summary from Fast, skipping batch",
      );
      continue;
    }

    prevSummary = newSummary;
    anySuccess = true;
  }

  if (!anySuccess) {
    logger.warn({ sessionId: sid }, "summarize: no batch succeeded");
    return;
  }

  await SessionModel.updateOne(
    { _id: sessionId },
    {
      $set: {
        summary: prevSummary,
        summaryUpToMessageId: lastId,
      },
    },
  );
  await MessageModel.updateMany(
    { _id: { $in: cut.map((x) => x.id) } },
    { $set: { summarized: true } },
  );

  logger.info(
    {
      sessionId: sid,
      summarized: cut.length,
      batches: batches.length,
      summaryLen: prevSummary.length,
    },
    "rolling summary updated",
  );
}
