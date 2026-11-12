// scripts/recordSse.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE_URL = process.env.RECORD_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.argv[2] ?? process.env.RECORD_EMAIL;
const PASSWORD = process.argv[3] ?? process.env.RECORD_PASSWORD;

interface PromptDef {
  name: string;
  text: string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "text-code",
    text: "Tulis fungsi TypeScript sederhana bernama add(a: number, b: number) yang mengembalikan penjumlahan, lalu jelaskan singkat apa fungsinya.",
  },
  {
    name: "table",
    text: "Buatkan tabel perbandingan 3 framework JavaScript populer (React, Vue, Angular) beserta tahun rilis dan bahasa utamanya.",
  },
  {
    name: "file",
    text: "Buatkan file README.md sederhana untuk project hello-world TypeScript, lalu tampilkan sebagai file.",
  },
];

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    console.error(
      "Usage: bun --env-file=.env scripts/recordSse.ts <email> <password>",
    );
    process.exit(1);
  }

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `login failed: ${loginRes.status} ${await loginRes.text()}`,
    );
  }
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error("no session cookie from login");

  const createRes = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ title: "SSE recording" }),
  });
  if (!createRes.ok) {
    throw new Error(
      `create session: ${createRes.status} ${await createRes.text()}`,
    );
  }
  const session = (await createRes.json()) as { id: string };
  console.log(`session: ${session.id}`);

  const outDir = join(process.cwd(), "docs", "samples");
  await mkdir(outDir, { recursive: true });

  for (const p of PROMPTS) {
    const res = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: p.text }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`send ${p.name}: ${res.status} ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const path = join(outDir, `${p.name}.sse`);
    await writeFile(path, buf);
    console.log(`wrote ${path} (${buf.length} bytes)`);
  }
  console.log("done");
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
