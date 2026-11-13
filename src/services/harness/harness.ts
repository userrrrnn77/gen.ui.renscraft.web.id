// src/services/harness/harness.ts
import { env } from "../../config/env.js";
import type { ReasoningEffort } from "../llm/provider.js";

export interface HarnessDecision {
  complexity: "simple" | "standard" | "complex";
  model: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

export interface HarnessInput {
  text: string;
  attachmentCount: number;
  fileCount: number;
  historyLen: number;
  hasRetrieval: boolean;
}

const HEAVY_VERBS =
  /analisis|bandingkan|debug|rancang|arsitektur|buktikan|optimasi|strategi|step by step|kenapa error/i;

export function classifyTurn(input: HarnessInput): HarnessDecision {
  if (!env.HARNESS_ENABLED) {
    return {
      complexity: "standard",
      model: env.MODEL_MAIN,
      reasoning: env.REASONING_DEFAULT,
      maxTokens: env.MAX_OUTPUT_TOKENS,
    };
  }

  const isSimple =
    input.text.length <= 80 &&
    !input.text.includes("```") &&
    !HEAVY_VERBS.test(input.text) &&
    input.attachmentCount === 0 &&
    !input.hasRetrieval;

  if (isSimple) {
    return {
      complexity: "simple",
      model: env.HARNESS_ROUTE_FAST ? env.MODEL_FAST : env.MODEL_MAIN,
      reasoning: "off",
      maxTokens: env.MAX_OUTPUT_TOKENS,
    };
  }

  const isComplex =
    HEAVY_VERBS.test(input.text) ||
    input.text.includes("```") ||
    input.text.length > 600 ||
    input.attachmentCount >= 2 ||
    /\b\d+[\+\-\*\/\^]\d+\b/.test(input.text);

  if (isComplex) {
    const budget =
      env.REASONING_DEFAULT === "low"
        ? 1024
        : env.REASONING_DEFAULT === "medium"
          ? 4096
          : 16384;
    return {
      complexity: "complex",
      model: env.MODEL_MAIN,
      reasoning: "high",
      maxTokens: env.MAX_OUTPUT_TOKENS + budget,
    };
  }

  return {
    complexity: "standard",
    model: env.MODEL_MAIN,
    reasoning: env.REASONING_DEFAULT,
    maxTokens: env.MAX_OUTPUT_TOKENS,
  };
}
