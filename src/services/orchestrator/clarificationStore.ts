// src/services/orchestrator/clarificationStore.ts
import type { ClarificationQuestion } from "./clarification.js";
import { logger } from "../../config/logger.js";

export class ClarificationTimeoutError extends Error {
  constructor() {
    super("clarification timeout");
    this.name = "ClarificationTimeoutError";
  }
}

export class ClarificationAbortedError extends Error {
  constructor() {
    super("clarification aborted");
    this.name = "ClarificationAbortedError";
  }
}

interface PendingEntry {
  questionId: string;
  sessionId: string;
  userId: string;
  messageId: string;
  question: ClarificationQuestion;
  createdAt: number;
  resolve: (answer: string[]) => void;
  reject: (err: unknown) => void;
  answered: boolean;
}

const pending = new Map<string, PendingEntry>();

const SWEEP_INTERVAL_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

// Sweep best-effort agar tidak bocor bila resolve/timeout/abort gagal.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [qid, entry] of pending.entries()) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      entry.reject(new ClarificationTimeoutError());
      pending.delete(qid);
      logger.warn(
        { questionId: qid },
        "clarification store: swept stale entry",
      );
    }
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

export function createPending(p: {
  sessionId: string;
  userId: string;
  messageId: string;
  question: ClarificationQuestion;
}): {
  questionId: string;
  wait: (signal: AbortSignal, timeoutMs: number) => Promise<string[]>;
} {
  const questionId = crypto.randomUUID();
  let resolveFn: ((a: string[]) => void) | null = null;
  let rejectFn: ((err: unknown) => void) | null = null;
  const promise = new Promise<string[]>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const entry: PendingEntry = {
    questionId,
    sessionId: p.sessionId,
    userId: p.userId,
    messageId: p.messageId,
    question: p.question,
    createdAt: Date.now(),
    resolve: (a) => resolveFn?.(a),
    reject: (e) => rejectFn?.(e),
    answered: false,
  };
  pending.set(questionId, entry);

  const wait = (signal: AbortSignal, timeoutMs: number): Promise<string[]> => {
    return new Promise<string[]>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };

      const onAbort = (): void => {
        pending.delete(questionId);
        finish(() => reject(new ClarificationAbortedError()));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(() => {
        pending.delete(questionId);
        finish(() => reject(new ClarificationTimeoutError()));
      }, timeoutMs);
      timer.unref?.();

      promise.then(
        (a) => finish(() => resolve(a)),
        (e) => finish(() => reject(e)),
      );
    });
  };

  return { questionId, wait };
}

export type ResolveResult =
  | "ok"
  | "not_found"
  | "forbidden"
  | "already_answered";

export function resolvePending(p: {
  questionId: string;
  sessionId: string;
  userId: string;
  answer: string[];
}): ResolveResult {
  const entry = pending.get(p.questionId);
  if (!entry) return "not_found";
  if (entry.sessionId !== p.sessionId || entry.userId !== p.userId) {
    return "forbidden";
  }
  if (entry.answered) return "already_answered";
  entry.answered = true;
  pending.delete(p.questionId);
  entry.resolve(p.answer);
  return "ok";
}
