import { env } from "../src/config/env.js";

interface ModelList {
  data: Array<{ id: string }>;
}

async function main(): Promise<void> {
  const res = await fetch(`${env.NVIDIA_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
  });
  if (!res.ok) {
    console.error(
      `FAIL /models ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
    process.exit(1);
  }
  const json = (await res.json()) as ModelList;
  const available = new Set(json.data.map((m) => m.id));
  const wanted: Array<[string, string]> = [
    ["MODEL_MAIN", env.MODEL_MAIN],
    ["MODEL_VISION", env.MODEL_VISION],
    ["MODEL_FAST", env.MODEL_FAST],
    ["MODEL_SAFETY", env.MODEL_SAFETY],
  ];
  let allOk = true;
  for (const [name, id] of wanted) {
    if (available.has(id)) {
      console.log(`OK      ${name}=${id}`);
    } else {
      console.log(`MISSING ${name}=${id}`);
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}

void main();
