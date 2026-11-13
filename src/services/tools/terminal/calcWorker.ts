/// <reference lib="webworker" />
// src/services/tools/terminal/calcWorker.ts

import { create, all } from "mathjs";

const math = create(all, {});

interface WorkerInput {
  expression: string;
}

interface WorkerOutput {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function makeSafeScope(): Record<string, () => never> {
  const fail = (name: string) => (): never => {
    throw new Error(`${name} disabled in calc`);
  };
  return {
    import: fail("import"),
    createUnit: fail("createUnit"),
    evaluate: fail("evaluate"),
    parse: fail("parse"),
    simplify: fail("simplify"),
    derivative: fail("derivative"),
  };
}

self.onmessage = (e: MessageEvent<WorkerInput>): void => {
  const { expression } = e.data;
  const reply: WorkerOutput = { ok: false };
  try {
    const result = math.evaluate(expression, makeSafeScope());
    let out: unknown;
    if (
      typeof result === "number" ||
      typeof result === "string" ||
      typeof result === "boolean" ||
      result === null
    ) {
      out = result;
    } else if (typeof result === "object" && result !== null) {
      out = String(result);
    } else {
      out = String(result);
    }
    reply.ok = true;
    reply.result = out;
  } catch (err) {
    reply.ok = false;
    reply.error = err instanceof Error ? err.message : String(err);
  }
  self.postMessage(reply);
};
