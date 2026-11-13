// src/services/llm/providers/openaiCompat.ts
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { mapReasoning } from "../reasoningMap.js";
import type {
  LlmProvider,
  NormalizedChunk,
  StreamCompletionInput,
} from "../provider.js";
import type { StreamChunk } from "../nvidiaClient.js";

export class OpenAICompatProvider implements LlmProvider {
  name = "openai_compat";

  async *streamCompletion(
    input: StreamCompletionInput,
  ): AsyncGenerator<NormalizedChunk, void, void> {
    const extra = mapReasoning("openai_compat", input.model, input.reasoning);

    const body = {
      model: input.model,
      messages: input.messages,
      ...(input.tools?.length
        ? { tools: input.tools, tool_choice: input.toolChoice ?? "auto" }
        : {}),
      max_tokens: input.maxTokens,
      stream: true,
      ...extra,
    };

    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LLM_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstream ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const rawEvent = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);

          for (const line of rawEvent.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data) as StreamChunk;
              const delta = parsed.choices[0]?.delta;
              if (!delta) continue;
              yield {
                content: delta.content ?? undefined,
                thinking:
                  delta.reasoning_content ?? delta.reasoning ?? undefined,
                toolCalls: delta.tool_calls,
                usage: parsed.usage,
                finishReason: parsed.choices[0]?.finish_reason ?? null,
              };
            } catch (err) {
              logger.warn({ err }, "skip malformed openai_compat chunk");
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
