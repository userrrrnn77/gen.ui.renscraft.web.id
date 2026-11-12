// scripts/probeEmbedding.ts

import { env } from "../src/config/env.js";

const MODEL = "nvidia/nemotron-3.5-embed-8b";
const ENDPOINT = `${env.NVIDIA_BASE_URL}/embeddings`;

interface EmbedResponse {
  object: string;
  data: Array<{ object: string; index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

interface ProbeResult {
  ok: boolean;
  elapsedMs: number;
  dim: number;
  usage?: { prompt_tokens: number; total_tokens: number };
  error?: string;
}

async function embedOne(
  inputs: string[],
  inputType: "query" | "passage",
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: inputs,
        input_type: inputType,
        encoding_format: "float",
        truncate: "END",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        elapsedMs: elapsed,
        dim: 0,
        error: `${res.status} ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as EmbedResponse;
    const dim = json.data[0]?.embedding?.length ?? 0;
    const allSameDim = json.data.every(
      (d) => Array.isArray(d.embedding) && d.embedding.length === dim,
    );
    if (!allSameDim) {
      return {
        ok: false,
        elapsedMs: elapsed,
        dim,
        error: "mixed dims in response",
      };
    }
    return {
      ok: true,
      elapsedMs: elapsed,
      dim,
      ...(json.usage ? { usage: json.usage } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      dim: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  console.log(`=== ${MODEL} ===`);

  const single = await embedOne(
    ["apa itu TypeScript dan kenapa dipakai?"],
    "query",
  );
  console.log(
    `single-text  ${single.ok ? "PASS" : "FAIL"} ${single.elapsedMs}ms dim=${single.dim}` +
      (single.usage ? ` tokens=${single.usage.total_tokens}` : "") +
      (single.error ? ` error="${single.error}"` : ""),
  );

  // Batch 8 — simulasi ingestion (chunk yang sama-sekali masuk batch)
  const batch = Array.from(
    { length: 8 },
    (_, i) =>
      `Chunk uji nomor ${i + 1}. Ini teks sintetis untuk mengukur batched embedding.`,
  );
  const batched = await embedOne(batch, "passage");
  console.log(
    `batch-8      ${batched.ok ? "PASS" : "FAIL"} ${batched.elapsedMs}ms dim=${batched.dim}` +
      (batched.usage ? ` tokens=${batched.usage.total_tokens}` : "") +
      (batched.error ? ` error="${batched.error}"` : ""),
  );

  // Teks panjang — 1 chunk ~1000 char (sesuai chunker kita)
  const longText = "lorem ipsum dolor sit amet ".repeat(40).slice(0, 1000);
  const longProbe = await embedOne([longText], "passage");
  console.log(
    `long-1k      ${longProbe.ok ? "PASS" : "FAIL"} ${longProbe.elapsedMs}ms dim=${longProbe.dim}` +
      (longProbe.usage ? ` tokens=${longProbe.usage.total_tokens}` : "") +
      (longProbe.error ? ` error="${longProbe.error}"` : ""),
  );

  if (single.ok && batched.ok && longProbe.ok) {
    if (single.dim !== batched.dim || single.dim !== longProbe.dim) {
      console.error(
        `\n⚠️ dim tidak konsisten: ${single.dim}, ${batched.dim}, ${longProbe.dim}`,
      );
      process.exit(1);
    }
    console.log(
      `\n✅ konsisten, dim=${single.dim}. Set di .env:\n   EMBEDDING_MODEL=${MODEL}\n   EMBEDDING_DIM=${single.dim}\n   EMBEDDING_ENABLED=true`,
    );
  } else {
    process.exit(1);
  }
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
