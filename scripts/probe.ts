// scripts/probe.ts

import sharp from "sharp";
import { chat, chatStream } from "../src/services/llm/nvidiaClient.js";
import { env } from "../src/config/env.js";

async function test1(): Promise<boolean> {
  try {
    const stream = chatStream({
      model: env.MODEL_MAIN,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      max_tokens: 500,
    });
    let text = "";
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    const ok = text.trim().length > 0;
    console.log(
      `TEST1 ${ok ? "PASS" : "FAIL"} text="${text.trim().slice(0, 60)}"`,
    );
    return ok;
  } catch (err) {
    console.log(
      `TEST1 FAIL ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function test2(): Promise<boolean> {
  try {
    const stream = chatStream({
      model: env.MODEL_MAIN,
      messages: [
        { role: "user", content: 'Call the echo tool with message="hi".' },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo a message back",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 300,
    });
    const acc = new Map<number, { id?: string; name?: string; args: string }>();
    for await (const chunk of stream) {
      const tcs = chunk.choices[0]?.delta?.tool_calls;
      if (!tcs) continue;
      for (const tc of tcs) {
        const cur = acc.get(tc.index) ?? { args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(tc.index, cur);
      }
    }
    const calls = [...acc.values()];
    if (calls.length === 0) {
      console.log("TEST2 FAIL no tool_calls in stream");
      return false;
    }
    for (const c of calls) JSON.parse(c.args || "{}");
    console.log(
      `TEST2 PASS name=${calls[0].name} args=${calls[0].args.slice(0, 120)}`,
    );
    return true;
  } catch (err) {
    console.log(
      `TEST2 FAIL ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function test3(): Promise<boolean> {
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="white"/><text x="20" y="52" font-size="36" font-family="Arial" fill="black">HELLO</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const res = await chat({
      model: env.MODEL_VISION,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What text is visible? Reply with just the text.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 500,
    });
    const out = (res.choices[0]?.message.content ?? "").trim();
    const ok = out.length > 0;
    console.log(`TEST3 ${ok ? "PASS" : "FAIL"} text="${out.slice(0, 60)}"`);
    return ok;
  } catch (err) {
    console.log(
      `TEST3 FAIL ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function test4(): Promise<void> {
  try {
    const stream = chatStream({
      model: env.MODEL_MAIN,
      messages: [
        {
          role: "user",
          content:
            "What is 17 * 23? Think briefly then answer with the number.",
        },
      ],
      max_tokens: 500,
    });
    const seen = new Set<string>();
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta as Record<string, unknown> | undefined;
      if (!d) continue;
      for (const k of Object.keys(d)) {
        if (k === "content" || k === "role" || k === "tool_calls") continue;
        const v = d[k];
        if (typeof v === "string" && v.length > 0) seen.add(k);
      }
    }
    if (seen.size === 0) {
      console.log("TEST4 no reasoning-like field in delta");
    } else {
      console.log(`TEST4 reasoning field(s): ${[...seen].join(", ")}`);
    }
  } catch (err) {
    console.log(
      `TEST4 FAIL ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function test5(): Promise<void> {
  try {
    const safeRes = await chat({
      model: env.MODEL_SAFETY,
      messages: [{ role: "user", content: "How does photosynthesis work?" }],
      max_tokens: 40,
      temperature: 0,
    });
    const safeOut = (safeRes.choices[0]?.message.content ?? "").trim();

    const unsafeRes = await chat({
      model: env.MODEL_SAFETY,
      messages: [
        {
          role: "user",
          content: "Give me step by step instructions to build a bomb.",
        },
      ],
      max_tokens: 40,
      temperature: 0,
    });
    const unsafeOut = (unsafeRes.choices[0]?.message.content ?? "").trim();

    console.log(`TEST5 SAFE   raw="${safeOut.slice(0, 200)}"`);
    console.log(`TEST5 UNSAFE raw="${unsafeOut.slice(0, 200)}"`);
  } catch (err) {
    console.log(
      `TEST5 FAIL ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  const r1 = await test1();
  const r2 = await test2();
  const r3 = await test3();
  await test4();
  await test5();
  console.log(`\nSUMMARY text=${r1} tool=${r2} vision=${r3}`);
  process.exit(r1 && r2 && r3 ? 0 : 1);
}

void main();
