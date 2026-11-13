// src/services/tools/terminal/commands/calc.ts

import { z } from "zod";
import { registerCommand } from "../registry.js";

const CalcArgs = z.object({
  expression: z.string().min(1).max(500),
});

const WORKER_TIMEOUT_MS = 2000;
const HARD_TIMEOUT_MS = 2500;

interface WorkerOutput {
  ok: boolean;
  result?: unknown;
  error?: string;
}

registerCommand({
  name: "calc",
  description:
    'Evaluasi ekspresi matematika (mathjs). Contoh: {"expression":"2340000 * 0.125"} atau {"expression":"sqrt(2) + pi"}. Fungsi berbahaya (import, evaluate, parse, dsb) dimatikan.',
  argsSchema: CalcArgs,
  timeoutMs: HARD_TIMEOUT_MS,
  async run(args) {
    const a = CalcArgs.parse(args);

    const workerUrl = new URL("../calcWorker.ts", import.meta.url);
    const worker = new Worker(workerUrl);

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (payload: {
        ok: boolean;
        data?: unknown;
        error?: string;
      }): void => {
        if (settled) return;
        settled = true;
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        resolve(payload);
      };

      const timer = setTimeout(
        () => finish({ ok: false, error: "TIMEOUT" }),
        WORKER_TIMEOUT_MS,
      );
      timer.unref?.();

      worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
        clearTimeout(timer);
        const d = e.data;
        if (d.ok) finish({ ok: true, data: { result: d.result } });
        else finish({ ok: false, error: d.error ?? "EVAL_ERROR" });
      };
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer);
        finish({ ok: false, error: e.message || "WORKER_ERROR" });
      };

      worker.postMessage({ expression: a.expression });
    });
  },
});
