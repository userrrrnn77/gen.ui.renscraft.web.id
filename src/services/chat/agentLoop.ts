// src/services/chat/agentLoop.ts

import { Types } from "mongoose";
import {
  chatStream,
  type ChatMessage,
  type Usage,
  type ToolDefinition,
} from "../llm/nvidiaClient.js";
import { FenceParser } from "../llm/fenceParser.js";
import type { Block } from "../blocks/schemas.js";
import { env } from "../../config/env.js";
import { BlockEmitter } from "./blockEmitter.js";
import {
  getTool,
  errorResult,
  listToolNames,
  type ToolContext,
  type ToolResult,
  type ToolDef,
} from "../tools/registry.js";

export interface AgentCallbacks {
  onToolStart: (callId: string, name: string) => void;
  onToolEnd: (callId: string, ok: boolean, summary: string) => void;
}

export interface AgentInput {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  sseSend: (event: string, data: unknown) => void;
  callbacks: AgentCallbacks;
  signal: AbortSignal;
}

export interface AgentResult {
  blocks: Block[];
  toolCalls: Array<{ id: string; name: string; argsJson: string }>;
  usage?: Usage;
  aborted: boolean;
  error?: string;
  endTurnByChoices: boolean;
}

interface PartialToolCall {
  id?: string;
  name?: string;
  args: string;
}

const MAX_ITER = env.MAX_TOOL_ITERATIONS;
const MAX_ARG_REPAIR = 2;

function accumulate(
  acc: Map<number, PartialToolCall>,
  list: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const tc of list) {
    const cur = acc.get(tc.index) ?? { args: "" };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    acc.set(tc.index, cur);
  }
}

function finalize(
  acc: Map<number, PartialToolCall>,
): Array<{ id: string; name: string; args: string }> {
  const out: Array<{ id: string; name: string; args: string }> = [];
  for (const [, v] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!v.id || !v.name) continue;
    out.push({ id: v.id, name: v.name, args: v.args });
  }
  return out;
}

async function executeWithRepair(
  tool: ToolDef,
  argsStr: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Tidak ada retry args yang sama: kalau tool.run side-effect (R2/DB)
  // sukses tapi langkah berikutnya gagal, retry bikin orphan. Model
  // yang akan retry di iterasi berikut via loop utama.
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr || "{}");
  } catch (e) {
    return errorResult(
      "INVALID_JSON",
      `Args bukan JSON valid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return await tool.run(parsed, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult("INVALID_ARGS", `Args tidak sesuai schema: ${msg}`, {
      tool: tool.name,
    });
  }
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const emitter = new BlockEmitter(input.sseSend);
  const accumulatedToolCalls: Array<{
    id: string;
    name: string;
    argsJson: string;
  }> = [];
  let usage: Usage | undefined;
  let aborted = false;
  let error: string | undefined;
  let endTurnByChoices = false;
  let natural = false;

  const workingMessages: ChatMessage[] = [...input.messages];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (input.signal.aborted) {
      aborted = true;
      break;
    }

    const parser = new FenceParser({
      start: (_i, block) => emitter.start(block),
      delta: (i, delta) => emitter.delta(i, delta),
      end: (i, block) => emitter.end(i, block),
    });

    const toolCallAcc = new Map<number, PartialToolCall>();
    let iterError: string | undefined;
    let iterContent = "";

    try {
      const stream = chatStream(
        {
          model: env.MODEL_MAIN,
          messages: workingMessages,
          ...(input.tools.length > 0
            ? { tools: input.tools, tool_choice: "auto" as const }
            : {}),
          max_tokens: env.MAX_OUTPUT_TOKENS,
        },
        input.signal,
      );

      for await (const chunk of stream) {
        if (input.signal.aborted) {
          aborted = true;
          break;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          parser.feed(delta.content);
          iterContent += delta.content;
        }
        if (delta.tool_calls) accumulate(toolCallAcc, delta.tool_calls);
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      if (input.signal.aborted) aborted = true;
      else iterError = err instanceof Error ? err.message : String(err);
    }

    parser.finish();

    if (aborted) break;
    if (iterError) {
      error = iterError;
      break;
    }

    const calls = finalize(toolCallAcc);
    if (calls.length === 0) {
      natural = true;
      break;
    }

    workingMessages.push({
      role: "assistant",
      content: iterContent,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    });

    let shouldBreak = false;

    for (const call of calls) {
      accumulatedToolCalls.push({
        id: call.id,
        name: call.name,
        argsJson: call.args,
      });

      input.callbacks.onToolStart(call.id, call.name);

      const tool = getTool(call.name);
      let toolResult: ToolResult;

      if (!tool) {
        toolResult = errorResult(
          "TOOL_NOT_FOUND",
          `Tool ${call.name} does not exist`,
          { available: listToolNames() },
        );
      } else {
        toolResult = await executeWithRepair(tool, call.args, {
          userId: input.userId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          abortSignal: input.signal,
          emit: input.sseSend,
          emitBlock: (b) => emitter.emitAtomic(b),
          iteration: iter,
        });
      }

      input.callbacks.onToolEnd(
        call.id,
        toolResult.ok,
        toolResult.ok
          ? `${call.name} ok`
          : `error: ${toolResult.content.slice(0, 120)}`,
      );

      workingMessages.push({
        role: "tool",
        content: toolResult.content,
        tool_call_id: call.id,
      });

      if (toolResult.endTurn) {
        endTurnByChoices = true;
        shouldBreak = true;
      }
    }

    if (shouldBreak) {
      natural = true;
      break;
    }
  }

  if (!natural && !aborted && !error) {
    emitter.emitAtomic({
      type: "text",
      markdown: "_Aku mencapai batas langkah, ini hasil sejauh ini._",
    });
  }

  return {
    blocks: emitter.blocks,
    toolCalls: accumulatedToolCalls,
    ...(usage !== undefined ? { usage } : {}),
    aborted,
    ...(error !== undefined ? { error } : {}),
    endTurnByChoices,
  };
}
