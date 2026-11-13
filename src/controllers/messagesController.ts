// src/controllers/messagesController.ts
import type { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { SessionModel } from "../models/Session.js";
import { MessageModel } from "../models/Message.js";
import { FileDocModel } from "../models/FileDoc.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseSessionId } from "../utils/params.js";
import {
  setupSseHeaders,
  createSseSender,
  startPing,
} from "../services/chat/sse.js";
import { estimateTokens } from "../services/chat/contextBuilder.js";
import { logger } from "../config/logger.js";
import {
  registerStream,
  unregisterStream,
} from "../services/chat/activeStreams.js";
import { runTurn } from "../services/orchestrator/coordinator.js";
import { RunTurnResult } from "@services/orchestrator/types.js";
import {
  resolvePending,
  type ResolveResult,
} from "../services/orchestrator/clarificationStore.js";
import { UserModel } from "@models/User.js";
import { Usage } from "@services/llm/nvidiaClient.js";
import { Block } from "@services/blocks/schemas.js";

const PostMessageBody = z.object({
  text: z.string().min(1).max(100_000),
  attachmentIds: z.array(z.string()).optional(),
});

const RespondBody = z.object({
  questionId: z.string().min(1).max(128),
  answer: z.array(z.string().min(1).max(2000)).min(1).max(6),
});

const ATTACHMENT_WAIT_MS = 90_000;

type FinalStatus = "done" | "aborted" | "error";

export async function postMessage(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  const body = PostMessageBody.parse(req.body);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  // Validasi attachment (ownership + id format)
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

  // SSE setup
  setupSseHeaders(res);
  const sse = createSseSender(res);
  const ping = startPing(sse);

  const ac = new AbortController();
  registerStream(ac);

  let clientDisconnected = false;
  const onClose = (): void => {
    if (res.writableEnded) return;
    if (ac.signal.aborted) return;
    clientDisconnected = true;
    logger.info(
      { sessionId: session._id.toString() },
      "client disconnected; aborting stream",
    );
    ac.abort();
  };
  res.on("close", onClose);

  const assistantId = new Types.ObjectId();
  let terminalEventSent = false;
  const sendEnd = (
    status: "done" | "aborted" | "error",
    usage: RunTurnResult["usage"] | null,
  ): void => {
    if (terminalEventSent) return;
    terminalEventSent = true;
    sse.send("message.end", {
      messageId: assistantId.toString(),
      status,
      usage: usage ?? null,
    });
  };

  try {
    sse.send("message.start", {
      messageId: assistantId.toString(),
      sessionId: session._id.toString(),
    });

    let result: RunTurnResult;
    try {
      result = await runTurn({
        userId,
        sessionId: session._id,
        messageId: assistantId,
        userMessageId: userMsg._id,
        text: body.text,
        attachmentIds,
        sseSend: sse.send,
        signal: ac.signal,
      });
    } catch (err) {
      // Defensive: coordinator seharusnya selalu return, tapi kalau throw,
      // kita tetap kirim error + message.end.
      logger.error({ err }, "runTurn threw unexpectedly");
      if (!clientDisconnected && !ac.signal.aborted) {
        sse.send("error", {
          code: err instanceof AppError ? err.code : "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      sendEnd(ac.signal.aborted ? "aborted" : "error", null);
      return;
    }

    if (result.error && !clientDisconnected && !ac.signal.aborted) {
      sse.send("error", {
        code: result.errorCode ?? "STREAM_ERROR",
        message: result.error,
      });
    }

    sendEnd(result.status, result.usage ?? null);
  } catch (err) {
    logger.error({ err }, "postMessage error after SSE start");
    if (!clientDisconnected && !ac.signal.aborted) {
      sse.send("error", {
        code: err instanceof AppError ? err.code : "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    sendEnd(ac.signal.aborted ? "aborted" : "error", null);
  } finally {
    unregisterStream(ac);
    clearInterval(ping);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

export async function respondClarification(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  const body = RespondBody.parse(req.body);
  const userId = getUserId(res);

  // Verifikasi kepemilikan sesi — mencegah info-leak lewat questionId.
  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  const result: ResolveResult = resolvePending({
    questionId: body.questionId,
    sessionId: sessionId.toString(),
    userId: userId.toString(),
    answer: body.answer,
  });

  switch (result) {
    case "ok":
      res.json({ ok: true });
      return;
    case "not_found":
      throw AppError.notFound("Question not found or expired");
    case "forbidden":
      throw AppError.forbidden("Not your question");
    case "already_answered":
      throw AppError.conflict("Question already answered");
  }
}
