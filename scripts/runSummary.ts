// scripts/runSummary.ts

import { Types } from "mongoose";
import { connectToDatabase } from "../src/db/connect.js";
import { maybeSummarize } from "../src/chat/summarizer.js";
import { logger } from "../src/config/logger.js";

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw || !Types.ObjectId.isValid(raw)) {
    console.error(
      "Usage: bun --env-file=.env scripts/runSummary.ts <sessionId>",
    );
    process.exit(1);
  }
  await connectToDatabase();
  const sid = new Types.ObjectId(raw);
  logger.info({ sessionId: raw }, "manual maybeSummarize triggered");
  const t0 = Date.now();
  await maybeSummarize(sid);
  logger.info(
    { sessionId: raw, durationMs: Date.now() - t0 },
    "manual maybeSummarize done",
  );
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
