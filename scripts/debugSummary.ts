// scripts/debugSummary.ts

import { connectToDatabase } from "../src/db/connect.js";
import { Types } from "mongoose";
import { MessageModel } from "../src/models/Message.js";
import { blocksToText, estimateTokens } from "../src/chat/contextBuilder.js";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  await connectToDatabase();
  const raw = process.argv[2];
  if (!raw || !Types.ObjectId.isValid(raw)) {
    console.error(
      "Usage: bun --env-file=.env scripts/debugSummary.ts <sessionId>",
    );
    process.exit(1);
  }
  const sid = new Types.ObjectId(raw);

  console.log("--- env ---");
  console.log("HISTORY_TOKEN_BUDGET:", env.HISTORY_TOKEN_BUDGET);

  const all = await MessageModel.countDocuments({ sessionId: sid });
  const done = await MessageModel.countDocuments({
    sessionId: sid,
    status: "done",
  });
  const assigned = await MessageModel.countDocuments({
    sessionId: sid,
    summarized: true,
  });
  const unsummarized = await MessageModel.countDocuments({
    sessionId: sid,
    summarized: { $ne: true },
  });
  console.log(
    `messages: total=${all} done=${done} summarized:true=${assigned} unsummarized=${unsummarized}`,
  );

  const messages = await MessageModel.find({
    sessionId: sid,
    summarized: { $ne: true },
    role: { $in: ["user", "assistant"] },
    status: { $in: ["done", "aborted"] },
  })
    .sort({ createdAt: 1 })
    .lean();

  console.log(`query matched: ${messages.length}`);

  let total = 0;
  let firstShown = false;
  let lastShown = false;
  for (const m of messages) {
    const blocksOk = Array.isArray(m.blocks);
    const text = blocksToText(m.blocks);
    const t = estimateTokens(text);
    total += t;

    if (!firstShown) {
      console.log(
        `  first: role=${m.role} blocksArray=${blocksOk} blocksLen=${blocksOk ? m.blocks.length : "n/a"} textLen=${text.length} tokens=${t}`,
      );
      firstShown = true;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!lastShown) {
      const m = messages[i];
      const blocksOk = Array.isArray(m.blocks);
      const text = blocksToText(m.blocks);
      const t = estimateTokens(text);
      console.log(
        `  last:  role=${m.role} blocksArray=${blocksOk} blocksLen=${blocksOk ? m.blocks.length : "n/a"} textLen=${text.length} tokens=${t}`,
      );
      lastShown = true;
    }
  }

  console.log(`total tokens: ${total}`);
  console.log(`over budget? ${total > env.HISTORY_TOKEN_BUDGET}`);

  // Simulasi cut logic
  if (total > env.HISTORY_TOKEN_BUDGET) {
    const target = env.HISTORY_TOKEN_BUDGET * 0.5;
    let remaining = total;
    let cutIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (remaining <= target) break;
      remaining -= estimateTokens(blocksToText(messages[i].blocks));
      cutIdx = i;
    }
    while (cutIdx >= 0 && messages[cutIdx].role !== "assistant") cutIdx--;
    console.log(
      `would cut at idx=${cutIdx} (role=${cutIdx >= 0 ? messages[cutIdx].role : "n/a"}), cutCount=${cutIdx + 1}`,
    );
  } else {
    console.log("would SKIP (under budget)");
  }

  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
