// src/tools/terminal.ts

import { z } from "zod";
import { registerTool, errorResult, okResult } from "./registry.js";
import {
  getCommand,
  listCommands,
  listCommandNames,
} from "./terminal/registry.js";
import { runTerminalCommand } from "./terminal/runner.js";

// Side-effect: register all safelisted commands
import "./terminal/commands/calc.js";
import "./terminal/commands/format_json.js";
import "./terminal/commands/csv_stats.js";
import "./terminal/commands/file_hash.js";
import "./terminal/commands/word_count.js";
import "./terminal/commands/pdf_info.js";
import "./terminal/commands/list_files.js";

function buildDescription(): string {
  const lines = listCommands().map((c) => `- ${c.name}: ${c.description}`);
  return `Jalankan command terbatas (safelist). Tidak ada shell, tidak ada akses jaringan. Hanya command di bawah yang diizinkan:\n${lines.join("\n")}\n\nJika user minta perintah shell (rm, ls, curl, apt, dsb), tolak dengan sopan dan tawarkan command yang tersedia.`;
}

const RunCommandSchema = z.object({
  command: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

registerTool({
  name: "run_command",
  kind: "command",
  description: buildDescription(),
  schema: RunCommandSchema,
  async run(rawArgs, ctx) {
    const parsed = RunCommandSchema.parse(rawArgs);

    const cmd = getCommand(parsed.command);
    if (!cmd) {
      return errorResult(
        "COMMAND_NOT_ALLOWED",
        `Command "${parsed.command}" tidak ada di safelist`,
        { allowed: listCommandNames() },
      );
    }

    const result = await runTerminalCommand(
      { command: parsed.command, args: parsed.args },
      {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
      },
    );

    if (!result.ok) {
      const hints: Record<string, unknown> = {
        allowed: listCommandNames(),
      };
      if (result.error === "INVALID_ARGS") {
        hints.commandSchema = z.toJSONSchema(cmd.argsSchema, {
          target: "draft-7",
          io: "input",
        });
        if (result.data !== undefined) hints.detail = result.data;
      } else if (
        result.error === "COMMAND_ERROR" ||
        result.error === "PDFINFO_FAILED"
      ) {
        if (result.data !== undefined) hints.detail = result.data;
      }
      return errorResult(
        result.error ?? "COMMAND_ERROR",
        `run_command ${parsed.command} gagal: ${result.error ?? "unknown"}`,
        hints,
      );
    }

    const data =
      typeof result.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : { result: result.data };

    return okResult({ command: parsed.command, ...data });
  },
});
