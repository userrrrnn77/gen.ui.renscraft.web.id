// src/tools/terminal/runner.ts

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Types } from "mongoose";
import { FileDocModel } from "../../models/FileDoc.js";
import { ToolRunModel } from "../../models/ToolRun.js";
import { getStorage } from "../../storage/index.js";
import { logger } from "../../config/logger.js";
import {
  getCommand,
  listCommandNames,
  type TerminalCommandContext,
  type TerminalCommandResult,
} from "./registry.js";

const MAX_OUTPUT = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const FILE_ID_REGEX = /^[a-f0-9]{24}$/i;
const SAFE_NAME_REGEX = /[^a-zA-Z0-9._-]/g;
const MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin";

// ─── Rate limit (sliding window in-memory per user) ────────────────────────

const rateBuckets = new Map<string, number[]>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateBuckets.get(userId) ?? [];
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(userId, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  return true;
}

// ─── Public types ─────────────────────────────────────────────────────────

export interface RunCommandInput {
  command: string;
  args: Record<string, unknown>;
}

export interface RunCommandContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
}

export interface RunCommandResult {
  ok: boolean;
  data?: unknown;
  /** Salah satu: RATE_LIMIT, COMMAND_NOT_ALLOWED, INVALID_ARGS, TIMEOUT, COMMAND_ERROR */
  error?: string;
  exitCode?: number;
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function runTerminalCommand(
  input: RunCommandInput,
  ctx: RunCommandContext,
): Promise<RunCommandResult> {
  const startedAt = Date.now();
  const userIdStr = ctx.userId.toString();

  if (!checkRateLimit(userIdStr)) {
    await recordRun(ctx, input, false, undefined, Date.now() - startedAt);
    return { ok: false, error: "RATE_LIMIT" };
  }

  const cmd = getCommand(input.command);
  if (!cmd) {
    await recordRun(ctx, input, false, undefined, Date.now() - startedAt);
    return { ok: false, error: "COMMAND_NOT_ALLOWED" };
  }

  // Validasi fileId (24 hex), tolak path separators & ".."
  const fileIdCheck = validateFileIdArgs(input.args);
  if (fileIdCheck !== null) {
    await recordRun(ctx, input, false, undefined, Date.now() - startedAt);
    return { ok: false, error: "INVALID_ARGS", data: fileIdCheck };
  }

  // Validasi args per command
  let parsedArgs: unknown;
  try {
    parsedArgs = cmd.argsSchema.parse(input.args);
  } catch (err) {
    await recordRun(ctx, input, false, undefined, Date.now() - startedAt);
    return {
      ok: false,
      error: "INVALID_ARGS",
      data: err instanceof Error ? err.message : String(err),
    };
  }

  const runId = crypto.randomUUID();
  const baseDir = join(tmpdir(), "genui", ctx.sessionId.toString());
  const workdir = join(baseDir, runId);
  await mkdir(workdir, { recursive: true });

  try {
    const termCtx: TerminalCommandContext = {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      runId,
      workdir,
      materializeFile: (fileId) => materializeFile(fileId, ctx, workdir),
      readFileText: (fileId) => readFileText(fileId, ctx),
      readFileBytes: (fileId) => readFileBytes(fileId, ctx),
    };

    let timedOut = false;
    const timeoutPromise = new Promise<TerminalCommandResult>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve({ ok: false, error: "TIMEOUT" });
      }, cmd.timeoutMs);
      t.unref?.();
    });

    const result = await Promise.race([
      cmd.run(parsedArgs, termCtx),
      timeoutPromise,
    ]);
    const durationMs = Date.now() - startedAt;

    await recordRun(ctx, input, result.ok, result.exitCode, durationMs);

    if (timedOut) return { ok: false, error: "TIMEOUT" };
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "COMMAND_ERROR",
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      };
    }
    return {
      ok: true,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, command: input.command, sessionId: ctx.sessionId.toString() },
      "terminal command threw",
    );
    await recordRun(ctx, input, false, undefined, durationMs);
    return { ok: false, error: "COMMAND_ERROR", data: message };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function validateFileIdArgs(args: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(args)) {
    if (key !== "fileId" || typeof value !== "string") continue;
    if (value.includes("..") || value.includes("/") || value.includes("\\")) {
      return "fileId tidak boleh mengandung path separators atau '..'";
    }
    if (!FILE_ID_REGEX.test(value)) {
      return "fileId harus 24 karakter hex";
    }
  }
  return null;
}

async function recordRun(
  ctx: RunCommandContext,
  input: RunCommandInput,
  ok: boolean,
  exitCode: number | undefined,
  durationMs: number,
): Promise<void> {
  try {
    const argsHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(input.args))
      .digest("hex");
    await ToolRunModel.create({
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      tool: "run_command",
      command: input.command,
      argsHash,
      ok,
      ...(exitCode !== undefined ? { exitCode } : {}),
      durationMs,
    });
  } catch (err) {
    logger.warn({ err }, "recordRun failed");
  }
}

async function loadOwnedFile(
  fileId: string,
  ctx: RunCommandContext,
): Promise<{
  name: string;
  size: number;
  storageKey: string;
  status: string;
}> {
  if (!FILE_ID_REGEX.test(fileId)) {
    throw new Error("fileId tidak valid");
  }
  const doc = await FileDocModel.findOne({
    _id: fileId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  }).lean();
  if (!doc) throw new Error("File tidak ditemukan di sesi ini");
  if (doc.status !== "ready") {
    throw new Error(`File status: ${doc.status}`);
  }
  return {
    name: doc.name,
    size: doc.size,
    storageKey: doc.storage.key,
    status: doc.status,
  };
}

async function materializeFile(
  fileId: string,
  ctx: RunCommandContext,
  workdir: string,
): Promise<string> {
  const meta = await loadOwnedFile(fileId, ctx);
  const storage = getStorage();
  const bytes = await storage.readBytes(meta.storageKey, meta.size);
  const safeName =
    meta.name.replace(SAFE_NAME_REGEX, "_").slice(0, 100) || "file";
  const target = join(workdir, safeName);
  await writeFile(target, Buffer.from(bytes));
  return safeName;
}

async function readFileText(
  fileId: string,
  ctx: RunCommandContext,
): Promise<string> {
  const meta = await loadOwnedFile(fileId, ctx);
  const storage = getStorage();
  const bytes = await storage.readBytes(meta.storageKey, meta.size);
  return Buffer.from(bytes).toString("utf-8");
}

async function readFileBytes(
  fileId: string,
  ctx: RunCommandContext,
): Promise<Buffer> {
  const meta = await loadOwnedFile(fileId, ctx);
  const storage = getStorage();
  const bytes = await storage.readBytes(meta.storageKey, meta.size);
  return Buffer.from(bytes);
}

// ─── Spawn helper (dipakai command yang butuh subprocess, mis. pdf_info) ──

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function spawnBounded(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<SpawnResult> {
  const proc = Bun.spawn([bin, ...args], {
    cwd: opts.cwd,
    env: { PATH: MINIMAL_PATH },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, opts.timeoutMs);
  timer.unref?.();

  try {
    const exitCode = await proc.exited;
    const stdoutBuf = await new Response(proc.stdout).arrayBuffer();
    const stderrBuf = await new Response(proc.stderr).arrayBuffer();
    const stdout = Buffer.from(stdoutBuf)
      .toString("utf-8")
      .slice(0, MAX_OUTPUT);
    const stderr = Buffer.from(stderrBuf)
      .toString("utf-8")
      .slice(0, MAX_OUTPUT);
    return { stdout, stderr, exitCode: killed ? -1 : exitCode };
  } finally {
    clearTimeout(timer);
  }
}
