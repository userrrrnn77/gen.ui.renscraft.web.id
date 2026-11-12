// scripts/checkSummary.ts
import { connectToDatabase } from "../src/db/connect.js";
import { SessionModel } from "../src/models/Session.js";
import { MessageModel } from "../src/models/Message.js";
import { Types } from "mongoose";

async function main(): Promise<void> {
  await connectToDatabase();
  const sid = process.argv[2];
  if (!sid || !Types.ObjectId.isValid(sid)) {
    console.error(
      "Usage: bun --env-file=.env scripts/checkSummary.ts <sessionId>",
    );
    process.exit(1);
  }
  const s = await SessionModel.findById(sid).lean();
  if (!s) {
    console.error("not found");
    process.exit(1);
  }
  const total = await MessageModel.countDocuments({ sessionId: sid });
  const sum = await MessageModel.countDocuments({
    sessionId: sid,
    summarized: true,
  });
  const unsum = await MessageModel.countDocuments({
    sessionId: sid,
    summarized: { $ne: true },
  });
  console.log("summary length:", (s.summary ?? "").length);
  console.log(
    "summary contains ORCHID-77:",
    (s.summary ?? "").includes("ORCHID-77"),
  );
  console.log("summaryUpToMessageId:", s.summaryUpToMessageId);
  console.log("total:", total, "summarized:", sum, "unsummarized:", unsum);
  process.exit(0);
}
void main();
