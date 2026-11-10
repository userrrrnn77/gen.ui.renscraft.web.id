// src/controllers/messagesController.ts

import type { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { SessionModel } from "../models/Session.js";
import { MessageModel } from "../models/Message.js";
import { UserModel } from "../models/User.js";
import { FileDocModel } from "../models/FileDoc.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseSessionId } from "../utils/params.js";
import { setupSseHeaders, createSseSender, startPing } from "../chat/sse.js";
import {
  buildContext,
  blocksToText,
  estimateTokens,
} from "../chat/contextBuilder.js";
import { runAgent } from "../chat/agentLoop.js";
import { generateTitle } from "../chat/titler.js";
import { buildToolDefinitions, listToolNames } from "../tools/index.js";
import { logger } from "../config/logger.js";
import { waitForReady } from "../ingest/index.js";

const PostMessageBody = z.object({
  text: z.string().min(1).max(100_000),
  attachmentIds: z.array(z.string()).optional(),
});

const ATTACHMENT_WAIT_MS = 90_000;

export async function postMessage(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  const body = PostMessageBody.parse(req.body);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  const user = await UserModel.findById(userId).lean();
  if (!user) throw AppError.unauthorized();

  const rawAttachmentIds = body.attachmentIds ?? [];
  const attachmentIds = rawAttachmentIds.filter((id) =>
    /^[a-f0-9]{24}$/i.test(id),
  );
  if (attachmentIds.length !== rawAttachmentIds.length) {
    throw AppError.badRequest("Some attachmentIds are invalid");
  }
  if (attachmentIds.length > 0) {
    const found = await FileDocModel.find({
      _id: { $in: attachmentIds },
      userId,
      sessionId: session._id,
    })
      .select({ _id: 1 })
      .lean();
    if (found.length !== attachmentIds.length) {
      throw AppError.badRequest("Some attachments not found in this session");
    }
  }

  const userMsg = await MessageModel.create({
    sessionId: session._id,
    userId,
    role: "user",
    blocks: [{ type: "text", markdown: body.text }],
    attachmentIds: attachmentIds.map((id) => new Types.ObjectId(id)),
    status: "done",
    tokenEstimate: estimateTokens(body.text),
  });

  await SessionModel.updateOne(
    { _id: session._id },
    { $set: { lastMessageAt: new Date() } },
  );

  setupSseHeaders(res);
  const sse = createSseSender(res);
  const ping = startPing(sse);

  const ac = new AbortController();
  const onClose = (): void => {
    if (ac.signal.aborted) return;
    logger.info({ sessionId: session._id.toString() }, "client closed; abort");
    ac.abort();
  };
  req.on("close", onClose);
  res.on("close", onClose);

  const assistantId = new Types.ObjectId();

  try {
    sse.send("message.start", {
      messageId: assistantId.toString(),
      sessionId: session._id.toString(),
    });

    if (attachmentIds.length > 0) {
      await waitForReady(attachmentIds, ATTACHMENT_WAIT_MS, ac.signal);
      const final = await FileDocModel.find({ _id: { $in: attachmentIds } })
        .select({ status: 1, error: 1, name: 1 })
        .lean();
      const failed = final.filter((f) => f.status !== "ready");
      if (failed.length > 0) {
        throw AppError.badRequest("Attachments not ready", {
          files: failed.map((f) => ({ name: f.name, error: f.error ?? null })),
        });
      }
    }

    const history = await MessageModel.find({
      sessionId: session._id,
      _id: { $ne: userMsg._id },
    })
      .sort({ createdAt: 1 })
      .lean();

    const files = await FileDocModel.find({
      sessionId: session._id,
      status: { $in: ["ready", "processing"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const { messages } = await buildContext({
      session: { summary: session.summary },
      user: { timezone: user.timezone },
      history: history.map((m) => ({
        _id: m._id,
        role: m.role,
        blocks: m.blocks,
        status: m.status,
        llm: m.llm,
      })),
      currentUserText: body.text,
      toolsAvailable: listToolNames(),
      files: files.map((f) => ({
        _id: f._id,
        name: f.name,
        mime: f.mime,
        status: f.status,
        version: f.version,
        summaryLine: f.summaryLine,
        origin: f.origin,
      })),
      attachmentIds,
    });

    const result = await runAgent({
      messages,
      tools: buildToolDefinitions(),
      userId,
      sessionId: session._id,
      messageId: assistantId,
      sseSend: sse.send,
      callbacks: {
        onToolStart: (callId, name) => sse.send("tool.start", { callId, name }),
        onToolEnd: (callId, ok, summary) =>
          sse.send("tool.end", { callId, ok, summary }),
      },
      signal: ac.signal,
    });

    const assistantStatus: "done" | "aborted" | "error" = result.aborted
      ? "aborted"
      : result.error
        ? "error"
        : "done";

    const assistantText = result.blocks.map((b) => blocksToText([b])).join("");

    const assistantMsg = await MessageModel.create({
      _id: assistantId,
      sessionId: session._id,
      userId,
      role: "assistant",
      blocks: result.blocks,
      attachmentIds: [],
      status: assistantStatus,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      llm: {
        toolCalls: result.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          argsJson: c.argsJson,
        })),
      },
      tokenEstimate: estimateTokens(assistantText),
    });

    await SessionModel.updateOne(
      { _id: session._id },
      { $set: { lastMessageAt: new Date() } },
    );

    if (assistantStatus === "done" && session.titleAuto) {
      const priorDoneAssistant = history.some(
        (m) => m.role === "assistant" && m.status === "done",
      );
      if (!priorDoneAssistant) {
        const title = await generateTitle(session._id.toString(), [
          { role: "user", content: body.text },
          { role: "assistant", content: assistantText.slice(0, 500) },
        ]);
        if (title) {
          sse.send("title", { sessionId: session._id.toString(), title });
        }
      }
    }

    if (result.error) {
      sse.send("error", { code: "STREAM_ERROR", message: result.error });
    }

    sse.send("message.end", {
      messageId: assistantId.toString(),
      status: assistantMsg.status,
      usage: result.usage ?? null,
    });
  } catch (err) {
    logger.error({ err }, "postMessage error after SSE start");
    sse.send("error", {
      code: err instanceof AppError ? err.code : "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearInterval(ping);
    req.off("close", onClose);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}
