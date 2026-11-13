// src/services/llm/reasoningMap.ts
import type { ReasoningEffort } from "./provider.js";

export function mapReasoning(
  provider: "nvidia" | "openai_compat",
  model: string,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (effort === "off") return {};

  if (provider === "nvidia") {
    // ASUMSI: field ini wajib diverifikasi dengan scripts/probe.ts
    const budget = effort === "low" ? 1024 : effort === "medium" ? 4096 : 16384;
    return {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: budget,
    };
  }

  if (provider === "openai_compat") {
    if (model.match(/^o[1-9]/) || model.startsWith("gpt-5")) {
      return { reasoning_effort: effort };
    }
    // deepseek-reasoner / deepseek-chat: otomatis dari model
  }

  return {};
}
