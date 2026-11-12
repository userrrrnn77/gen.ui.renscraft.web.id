// scripts/backfillEmbeddings.ts

import { Types } from "mongoose";
import { connectToDatabase } from "../src/db/connect.js";
import { ChunkModel } from "../src/models/Chunk.js";
import { embedAndStoreChunks } from "../src/ingest/embedder.js";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  if (!env.EMBEDDING_ENABLED) {
    console.error("EMBEDDING_ENABLED=false; nothing to do");
    process.exit(1);
  }
  await connectToDatabase();

  const sessionArg = process.argv[2];
  const filter: Record<string, unknown> = {
    embedding: { $exists: false },
  };
  if (sessionArg) {
    if (!Types.ObjectId.isValid(sessionArg)) {
      console.error("invalid sessionId");
      process.exit(1);
    }
    filter.sessionId = new Types.ObjectId(sessionArg);
  }

  let total = 0;
  let buffer: Array<{ _id: Types.ObjectId; text: string }> = [];

  const cursor = ChunkModel.find(filter)
    .select({ _id: 1, text: 1 })
    .batchSize(64)
    .cursor();

  for await (const c of cursor) {
    buffer.push({ _id: c._id, text: c.text });
    if (buffer.length >= env.EMBEDDING_BATCH_SIZE) {
      await embedAndStoreChunks(buffer);
      total += buffer.length;
      console.log(`embedded ${total}`);
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    await embedAndStoreChunks(buffer);
    total += buffer.length;
  }
  console.log(`done, total=${total}`);
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
