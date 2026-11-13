// src/services/tools/terminal/registry.ts

import type { z } from "zod";
import type { Types } from "mongoose";

export interface TerminalCommandContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  runId: string;
  workdir: string;
  /** Materialisasi file user ke workdir. Returns nama file di workdir. */
  materializeFile: (fileId: string) => Promise<string>;
  /** Baca file user sebagai teks UTF-8. */
  readFileText: (fileId: string) => Promise<string>;
  /** Baca file user sebagai Buffer (untuk hashing). */
  readFileBytes: (fileId: string) => Promise<Buffer>;
}

export interface TerminalCommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  exitCode?: number;
}

export interface TerminalCommand {
  name: string;
  description: string;
  argsSchema: z.ZodTypeAny;
  timeoutMs: number;
  run: (
    args: unknown,
    ctx: TerminalCommandContext,
  ) => Promise<TerminalCommandResult>;
}

const registry = new Map<string, TerminalCommand>();

export function registerCommand(cmd: TerminalCommand): void {
  if (registry.has(cmd.name)) {
    throw new Error(`Command already registered: ${cmd.name}`);
  }
  registry.set(cmd.name, cmd);
}

export function getCommand(name: string): TerminalCommand | undefined {
  return registry.get(name);
}

export function listCommands(): TerminalCommand[] {
  return [...registry.values()];
}

export function listCommandNames(): string[] {
  return [...registry.keys()];
}
