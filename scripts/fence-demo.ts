import { FenceParser } from "../src/llm/fenceParser.js";
import type { Block } from "../src/blocks/schemas.js";

function parseAll(chunks: string[]): Block[] {
  const parser = new FenceParser({
    start: () => {},
    delta: () => {},
    end: () => {},
  });
  for (const c of chunks) parser.feed(c);
  return parser.finish();
}

function fixedChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function randomChunks(text: string, seed: number): string[] {
  const out: string[] = [];
  let i = 0;
  let s = seed;
  while (i < text.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const size = (s % 8) + 1;
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function eq(a: Block[], b: Block[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const INPUTS = [
  "Halo! Ini teks biasa.\n\n```ts filename=src/app.ts\nconst x = 1;\nexport default x;\n```\n\nSelesai.",
  "Tanpa fence sama sekali.",
  "```py\nprint('hi')\n```",
  "Awal ```js\nconsole.log(1);\n``` akhir",
  "```\nunclosed code without language",
  '```ts\nconst a = 1;\n```\n\ntext\n\n```json\n{"k":1}\n```',
  "Teks **bold** dengan `inline` code.",
  "```\n\n```",
];

let failed = 0;
for (let idx = 0; idx < INPUTS.length; idx++) {
  const text = INPUTS[idx];
  const ref = parseAll([text]);
  for (const size of [1, 2, 3, 5, 7, 11]) {
    if (!eq(ref, parseAll(fixedChunks(text, size)))) {
      console.error(`MISMATCH input#${idx} fixed=${size}`);
      failed++;
    }
  }
  for (const seed of [1, 42, 1337]) {
    if (!eq(ref, parseAll(randomChunks(text, seed)))) {
      console.error(`MISMATCH input#${idx} seed=${seed}`);
      failed++;
    }
  }
}
if (failed > 0) {
  console.error(`\n${failed} mismatch(es)`);
  process.exit(1);
}
console.log(`fence-demo PASS across ${INPUTS.length} inputs`);
