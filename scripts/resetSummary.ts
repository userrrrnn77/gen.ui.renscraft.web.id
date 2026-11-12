// scripts/resetSummary.ts

import { Types } from "mongoose";
import { connectToDatabase } from "../src/db/connect.js";
import { SessionModel } from "../src/models/Session.js";
import { MessageModel } from "../src/models/Message.js";

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw || !Types.ObjectId.isValid(raw)) {
    console.error(
      "Usage: bun --env-file=.env scripts/resetSummary.ts <sessionId>",
    );
    process.exit(1);
  }
  await connectToDatabase();
  const sid = new Types.ObjectId(raw);
  const sess = await SessionModel.updateOne(
    { _id: sid },
    { $set: { summary: "", summaryUpToMessageId: null } },
  );
  const msgs = await MessageModel.updateMany(
    { sessionId: sid },
    { $set: { summarized: false } },
  );
  console.log(
    `reset session: ${sess.modifiedCount} doc, messages: ${msgs.modifiedCount} doc`,
  );
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
