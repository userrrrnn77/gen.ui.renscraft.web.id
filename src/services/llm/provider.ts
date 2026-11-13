// src/services/llm/provider.ts
import type {
  ChatMessage,
  ToolDefinition,
  Usage,
  ToolChoice,
} from "./nvidiaClient.js";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface StreamCompletionInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  reasoning: ReasoningEffort;
  signal: AbortSignal;
}

export interface NormalizedChunk {
  content?: string;
  thinking?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  usage?: Usage;
  finishReason?: string | null;
}

export interface LlmProvider {
  name: string;
  streamCompletion(
    input: StreamCompletionInput,
  ): AsyncGenerator<NormalizedChunk, void, void>;
}

export function getProvider(): LlmProvider {
  // Dynamic import untuk menghindari sirkular dependency
  if (process.env.LLM_PROVIDER === "openai_compat") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAICompatProvider } = require("./providers/openaiCompat.js");
    return new OpenAICompatProvider();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NvidiaProvider } = require("./providers/nvidia.js");
  return new NvidiaProvider();
}
