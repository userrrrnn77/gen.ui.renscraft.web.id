// scripts/testEmbedding.ts

import { env } from "../src/config/env.js";

const MODELS = [
  "nvidia/llama-3.2-nv-embedqa-1b-v2",
  "nvidia/llama-3.2-nv-embedqa-e5-v5",
  "nvidia/nv-embed-v1",
  "nvidia/nv-embedqa-mistral-7b-v2",
  "BAAI/bge-m3",
  "snowflake/arctic-embed-l",
];

interface EmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

async function probeModel(model: string): Promise<void> {
  const url = `${env.NVIDIA_BASE_URL}/embeddings`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        input: ["apa itu TypeScript", "cara belajar pemrograman"],
        input_type: "query",
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text();
      console.log(
        `  FAIL ${elapsed}ms status=${res.status} body="${text.slice(0, 160)}"`,
      );
      return;
    }
    const json = (await res.json()) as EmbedResponse;
    const dim = json.data[0]?.embedding?.length ?? 0;
    const usage = json.usage
      ? `tokens=${json.usage.total_tokens}`
      : "usage=n/a";
    console.log(`  PASS ${elapsed}ms dim=${dim} ${usage}`);
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.log(
      `  FAIL ${elapsed}ms ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    await probeModel(model);
  }
  console.log("\ndone");
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
