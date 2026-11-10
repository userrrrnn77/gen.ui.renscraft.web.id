// src/llm/nvidiaClient.ts

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

// ─── Types (subset OpenAI-compatible, sesuai PRD §2) ────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | { type: "function"; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamDelta {
  role?: Role;
  content?: string | null;
  // Nama field reasoning belum pasti (probe yang menentukan). Dukung dua
  // kandidat umum; agentLoop hanya akan pakai yang benar-benar muncul.
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface StreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

// ─── Error types ────────────────────────────────────────────────────────────

export class UpstreamError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`NVIDIA upstream ${status}: ${bodyText.slice(0, 300)}`);
    this.name = "UpstreamError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3; // percobaan pertama + 2 retry
const RETRY_BASE_MS = 500;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 60_000;

function isRetriable(err: unknown): boolean {
  return err instanceof UpstreamError && RETRY_STATUS.has(err.status);
}

function backoff(attempt: number): Promise<void> {
  const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
  return new Promise((r) => setTimeout(r, delay));
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function postJson<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  const res = await fetch(`${env.NVIDIA_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(res.status, text);
  }
  return (await res.json()) as T;
}

// ─── Non-streaming chat ─────────────────────────────────────────────────────

export async function chat(
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const body = { ...req, stream: false };
  const external = signal ?? new AbortController().signal;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await postJson<ChatResponse>("/chat/completions", body, external);
    } catch (err) {
      lastErr = err;
      if (external.aborted || !isRetriable(err) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      logger.warn(
        { attempt, status: (err as UpstreamError).status },
        "chat retry",
      );
      await backoff(attempt);
    }
  }
  throw lastErr;
}

// ─── Streaming chat (async generator) ───────────────────────────────────────

export async function* chatStream(
  req: ChatRequest,
  externalSignal?: AbortSignal,
): AsyncGenerator<StreamChunk, void, void> {
  const body = { ...req, stream: true };

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let yieldedAny = false;

    const ac = new AbortController();
    const onExternalAbort = (): void => ac.abort();
    if (externalSignal) {
      if (externalSignal.aborted) return;
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let timer = setTimeout(
      () => ac.abort(new Error("first-token timeout")),
      FIRST_TOKEN_TIMEOUT_MS,
    );
    const resetTimer = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error("idle timeout")), ms);
    };

    try {
      const res = await fetch(`${env.NVIDIA_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(res.status, text);
      }
      if (!res.body) {
        throw new Error("upstream response has no body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!yieldedAny) yieldedAny = true;
        resetTimer(IDLE_TIMEOUT_MS);

        buffer += decoder.decode(value, { stream: true });

        // SSE events diakhiri "\n\n" (atau "\r\n\r\n").
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const rawEvent = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);

          for (const rawLine of rawEvent.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "" || data === "[DONE]") {
              if (data === "[DONE]") return;
              continue;
            }
            let parsed: StreamChunk;
            try {
              parsed = JSON.parse(data) as StreamChunk;
            } catch (parseErr) {
              logger.warn(
                { sample: data.slice(0, 120), err: String(parseErr) },
                "skip malformed SSE chunk",
              );
              continue;
            }
            yield parsed;
          }
        }
      }
      return;
    } catch (err) {
      const externalAborted = externalSignal?.aborted === true;
      const retriable = isRetriable(err);

      if (
        yieldedAny ||
        externalAborted ||
        !retriable ||
        attempt >= MAX_ATTEMPTS
      ) {
        throw err;
      }
      logger.warn(
        { attempt, status: (err as UpstreamError).status },
        "stream retry",
      );
      await backoff(attempt);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
