// scripts/seedLongSession.ts

import { connectToDatabase } from "../src/db/connect.js";
import { UserModel } from "../src/models/User.js";
import { SessionModel } from "../src/models/Session.js";
import { MessageModel } from "../src/models/Message.js";
import type { Block } from "../src/blocks/schemas.js";

interface SeedMsg {
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: Date;
}

// ~1200 karakter per pesan supaya total 62 pesan ≈ 21000+ karakter ≈
// ~6000 token tambahan di atas teks inti. Dengan filler ~1200 char,
// total ≈ 62 × 1250 ≈ 77500 karakter ≈ 22000+ token — masih perlu
// filler lebih besar supaya melewati 24000. Pakai 2000 karakter.
const FILLER =
  "Ini adalah kalimat pengisi yang dibuat panjang untuk menguji mekanisme ringkasan percakapan bergulir pada backend GenUI. ".repeat(
    16,
  );

async function main(): Promise<void> {
  await connectToDatabase();
  const email = process.argv[2];
  if (!email) {
    console.error(
      "Usage: bun --env-file=.env scripts/seedLongSession.ts <email>",
    );
    process.exit(1);
  }

  const user = await UserModel.findOne({ email }).lean();
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const session = await SessionModel.create({
    userId: user._id,
    title: "Seed long session",
    titleAuto: false,
    lastMessageAt: new Date(),
  });

  const baseTime = Date.now() - 62 * 60 * 1000;
  const msgs: SeedMsg[] = [];
  for (let i = 0; i < 62; i++) {
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    let markdown: string;
    if (i === 0) {
      markdown = `Halo. Kode proyek saya ORCHID-77. Tolong ingat ya.\n\n${FILLER}`;
    } else if (i === 1) {
      markdown = `Baik, saya catat: kode proyek Anda adalah ORCHID-77.\n\n${FILLER}`;
    } else {
      markdown =
        role === "user"
          ? `Pesan uji #${i}. Tolong balas satu kalimat pendek.\n\n${FILLER}`
          : `Diterima pesan #${i}.\n\n${FILLER}`;
    }
    msgs.push({
      role,
      blocks: [{ type: "text", markdown }],
      createdAt: new Date(baseTime + i * 60_000),
    });
  }

  await MessageModel.insertMany(
    msgs.map((m) => ({
      sessionId: session._id,
      userId: user._id,
      role: m.role,
      blocks: m.blocks,
      attachmentIds: [],
      status: "done" as const,
      tokenEstimate: 0,
      createdAt: m.createdAt,
      updatedAt: m.createdAt,
    })),
  );

  const totalChars = msgs.reduce(
    (n, m) =>
      n + (m.blocks[0].type === "text" ? m.blocks[0].markdown.length : 0),
    0,
  );
  const totalTokens = Math.ceil(totalChars / 3.5);
  console.log(
    `Seeded session ${session._id.toString()} with ${msgs.length} messages (${totalChars} chars ≈ ${totalTokens} tokens) for ${email}`,
  );
  process.exit(0);
}

void main();
