// src/services/orchestrator/coordinator.ts

import { Types } from "mongoose";
import { SessionModel } from "../../models/Session.js";
import { MessageModel } from "../../models/Message.js";
import { UserModel } from "../../models/User.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { AppError } from "../../middleware/error.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  buildContext,
  blocksToText,
  estimateTokens,
} from "../chat/contextBuilder.js";
import { generateTitle } from "../chat/titler.js";
import { buildToolDefinitions, listToolNames } from "../tools/index.js";
import { maybeSummarize } from "../chat/summarizer.js";
import { checkSafety } from "../safety/guard.js";
import { BlockEmitter } from "../chat/blockEmitter.js";
import { waitForReady } from "../ingest/index.js";
import { detectClarification } from "./clarification.js";
import {
  createPending,
  ClarificationTimeoutError,
  ClarificationAbortedError,
} from "./clarificationStore.js";
import type { ClarificationQuestion } from "./clarification.js";
import type { Phase, RunTurnInput, RunTurnResult } from "./types.js";
import type { Block } from "../blocks/schemas.js";
import type { Usage, ChatMessage } from "../llm/nvidiaClient.js";
import { retrieveRelevantChunks, shouldRetrieve } from "../rag/retriever.js";
import { buildGroundedMessage, toSourcesPayload } from "../rag/generator.js";
import type { RetrievedChunk, SourcePayload } from "../rag/types.js";
import { embedTexts } from "../ingest/embedder.js";
import { classifyTurn } from "../harness/harness.js";
import { runAgent } from "../chat/agentLoop.js";

const LEGAL: Record<Phase, Phase[]> = {
  IDLE: ["CLARIFYING", "RETRIEVING", "GENERATING", "DONE", "ABORTED", "ERROR"],
  CLARIFYING: ["RETRIEVING", "GENERATING", "DONE", "ABORTED", "ERROR"],
  RETRIEVING: ["GENERATING", "ABORTED", "ERROR"],
  GENERATING: ["CLARIFYING", "DONE", "ABORTED", "ERROR"],
  DONE: [],
  ABORTED: [],
  ERROR: [],
};

function makeTransition(
  sseSend: (event: string, data: unknown) => void,
): (next: Phase) => void {
  let current: Phase = "IDLE";
  return (next: Phase): void => {
    if (current === next) return;
    if (!LEGAL[current].includes(next)) {
      throw new Error(`Illegal phase transition: ${current} → ${next}`);
    }
    current = next;
    if (
      next === "CLARIFYING" ||
      next === "RETRIEVING" ||
      next === "GENERATING"
    ) {
      sseSend("status", { phase: next.toLowerCase() });
    }
  };
}

const ATTACHMENT_WAIT_MS = 90_000;

async function saveAssistantMessage(
  messageId: Types.ObjectId,
  sessionId: Types.ObjectId,
  userId: Types.ObjectId,
  blocks: Block[],
  status: "done" | "aborted" | "error",
  extras: {
    usage?: Usage;
    toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
    sources?: SourcePayload[];
  } = {},
): Promise<void> {
  const text = blocks.map((b) => blocksToText([b])).join("");
  await MessageModel.create({
    _id: messageId,
    sessionId,
    userId,
    role: "assistant",
    blocks,
    attachmentIds: [],
    status,
    ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
    ...(extras.sources !== undefined ? { sources: extras.sources } : {}),
    ...(extras.toolCalls !== undefined
      ? { llm: { toolCalls: extras.toolCalls } }
      : {}),
    tokenEstimate: estimateTokens(text),
  });
  await SessionModel.updateOne(
    { _id: sessionId },
    { $set: { lastMessageAt: new Date() } },
  );
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    userId,
    sessionId,
    messageId,
    userMessageId,
    text,
    attachmentIds,
    sseSend,
    signal,
  } = input;

  const transition = makeTransition(sseSend);
  const emitter = new BlockEmitter(sseSend);

  // ── Stage A: Paralel loading ─────────────────────────────────────
  const [
    session,
    user,
    history,
    files,
    attachmentDigests,
    safety,
    preEmbedVec,
  ] = await Promise.all([
    SessionModel.findOne({ _id: sessionId, userId }).lean(),
    UserModel.findById(userId).lean(),
    MessageModel.find({
      sessionId,
      _id: { $ne: userMessageId },
      summarized: { $ne: true },
    })
      .sort({ createdAt: 1 })
      .lean(),
    FileDocModel.find({
      sessionId,
      status: { $in: ["ready", "processing"] },
    })
      .sort({ createdAt: 1 })
      .lean(),
    (async () => {
      if (attachmentIds.length === 0) return [];
      const attDocs = await FileDocModel.find({ _id: { $in: attachmentIds } })
        .select({ mime: 1, digest: 1 })
        .lean();
      return attDocs
        .filter((d) => d.mime.startsWith("image/") && d.digest !== undefined)
        .map((d) => ({
          summary: d.digest?.summary,
          ocrText: d.digest?.ocrText,
        }));
    })(),
    (async () => {
      // Safety butuh attachmentDigests — dijalankan setelah Promise.all
      // untuk kebersihan dependency. Placeholder agar Promise.all tidak
      // memblokir. Sebenarnya safety dijalankan di bawah setelah semua load.
      return null;
    })(),
    (async () => {
      if (!env.EMBEDDING_ENABLED) return null;
      try {
        const vecs = await embedTexts([text], "query");
        return vecs[0] ?? null;
      } catch (err) {
        logger.warn({ err }, "pre-embed query failed");
        return null;
      }
    })(),
  ]);

  if (!session) throw AppError.notFound();
  if (!user) throw AppError.unauthorized();

  let finalStatus: RunTurnResult["status"] = "error";
  let finalUsage: Usage | undefined;
  let finalError: string | undefined;
  let finalErrorCode: string | undefined;
  let clarificationInfo: RunTurnResult["clarification"] | undefined;
  let savedSources: SourcePayload[] | undefined;

  try {
    // ── Wait attachments (jika ada) ─────────────────────────────────
    if (attachmentIds.length > 0) {
      await waitForReady(attachmentIds, ATTACHMENT_WAIT_MS, signal);
      const final = await FileDocModel.find({ _id: { $in: attachmentIds } })
        .select({ status: 1, error: 1, name: 1 })
        .lean();
      if (final.length !== attachmentIds.length) {
        throw AppError.badRequest("Some attachments no longer exist");
      }
      const failed = final.filter((f) => f.status !== "ready");
      if (failed.length > 0) {
        throw AppError.badRequest("Attachments not ready", {
          files: failed.map((f) => ({
            name: f.name,
            error: f.error ?? null,
          })),
        });
      }
    }

    // ── Safety gate ─────────────────────────────────────────────────
    const safetyResult = await checkSafety({ text, attachmentDigests });
    if (!safetyResult.safe) {
      const refusal: Block = {
        type: "text",
        markdown:
          "Maaf, aku tidak bisa membantu dengan permintaan itu. Silakan ajukan pertanyaan lain.",
      };
      emitter.emitAtomic(refusal);
      await saveAssistantMessage(
        messageId,
        sessionId,
        userId,
        [refusal],
        "done",
      );
      finalStatus = "done";
      transition("DONE");
      return { status: "done", blocks: [refusal] };
    }

    // ── askClarification ────────────────────────────────────────────
    const askClarification = async (
      q: ClarificationQuestion,
      resumePhase: Phase = "GENERATING",
    ): Promise<string[]> => {
      const pending = createPending({
        sessionId: sessionId.toString(),
        userId: userId.toString(),
        messageId: messageId.toString(),
        question: q,
      });

      transition("CLARIFYING");
      sseSend("clarification.needed", {
        questionId: pending.questionId,
        question: q.question,
        multi: q.multi,
        options: q.options,
        timeoutMs: env.CLARIFICATION_TIMEOUT_MS,
      });

      const answer = await pending.wait(signal, env.CLARIFICATION_TIMEOUT_MS);

      sseSend("clarification.resolved", {
        questionId: pending.questionId,
        answer,
      });

      const choicesBlock: Block = {
        type: "choices",
        questionId: pending.questionId,
        question: q.question,
        multi: q.multi,
        options: q.options,
        answer,
      };
      emitter.emitAtomic(choicesBlock);

      transition(resumePhase);
      clarificationInfo = {
        questionId: pending.questionId,
        question: q.question,
        answer,
      };
      return answer;
    };

    // ── Clarification detection ─────────────────────────────────────
    let augmentedText = text;
    const question = detectClarification({
      text,
      attachmentIds,
      files: files.map((f) => ({
        _id: f._id,
        name: f.name,
        status: f.status,
        origin: f.origin,
        createdAt: f.createdAt,
      })),
      history: history.map((m) => ({ role: m.role, blocks: m.blocks })),
      enabled: env.CLARIFICATION_ENABLED,
    });

    if (question) {
      const doRetrievePre = shouldRetrieve({
        text: augmentedText,
        attachmentIds,
        files: files.map((f) => ({ _id: f._id, status: f.status })),
        enabled: env.RAG_ENABLED,
      });
      const resumePhase: Phase = doRetrievePre ? "RETRIEVING" : "GENERATING";

      try {
        const answer = await askClarification(question, resumePhase);
        augmentedText = `${text}\n\n[Klarifikasi user — "${question.question}": ${answer.join(", ")}]`;
      } catch (err) {
        if (err instanceof ClarificationTimeoutError) {
          emitter.emitAtomic({
            type: "text",
            markdown:
              "_Pertanyaan klarifikasi tidak dijawab dan dibatalkan. Kirim pesan lagi kapan saja._",
          });
          await saveAssistantMessage(
            messageId,
            sessionId,
            userId,
            emitter.blocks,
            "done",
          );
          finalStatus = "done";
          transition("DONE");
          return { status: "done", blocks: emitter.blocks };
        }
        if (err instanceof ClarificationAbortedError) {
          await saveAssistantMessage(
            messageId,
            sessionId,
            userId,
            emitter.blocks,
            "aborted",
          );
          finalStatus = "aborted";
          transition("ABORTED");
          return { status: "aborted", blocks: emitter.blocks };
        }
        throw err;
      }
    }

    // ── Retrieval ───────────────────────────────────────────────────
    let retrieved: RetrievedChunk[] = [];
    const doRetrieve = shouldRetrieve({
      text: augmentedText,
      attachmentIds,
      files: files.map((f) => ({ _id: f._id, status: f.status })),
      enabled: env.RAG_ENABLED,
    });

    if (doRetrieve) {
      transition("RETRIEVING");

      try {
        retrieved = await Promise.race([
          retrieveRelevantChunks(augmentedText, {
            sessionId,
            excludeFileIds: attachmentIds,
            topK: env.RAG_TOP_K,
            queryVec: Promise.resolve(preEmbedVec),
            signal,
          }),
          new Promise<RetrievedChunk[]>((resolve) => {
            const t = setTimeout(() => {
              logger.warn(
                { sessionId: sessionId.toString() },
                "retrieval timeout",
              );
              resolve([]);
            }, env.RAG_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
      } catch (err) {
        logger.warn({ err }, "retrieval failed; continuing without context");
        retrieved = [];
      }

      if (retrieved.length > 0) {
        sseSend("sources", { sources: toSourcesPayload(retrieved) });
        savedSources = toSourcesPayload(retrieved);
      }
    }

    // ── Build context & Harness ─────────────────────────────────────
    const extraSystemMessages: ChatMessage[] =
      retrieved.length > 0 ? [buildGroundedMessage(retrieved)] : [];

    const { messages } = await buildContext({
      session: { summary: session.summary ?? "" },
      user: { timezone: user.timezone },
      history: history.map((m) => ({
        _id: m._id,
        role: m.role,
        blocks: m.blocks,
        status: m.status,
        llm: m.llm,
      })),
      currentUserText: augmentedText,
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
      ...(extraSystemMessages.length > 0 ? { extraSystemMessages } : {}),
    });

    const harness = classifyTurn({
      text: augmentedText,
      attachmentCount: attachmentIds.length,
      fileCount: files.length,
      historyLen: history.length,
      hasRetrieval: retrieved.length > 0,
    });

    logger.info(
      { sessionId: sessionId.toString(), harness },
      "harness decision",
    );

    transition("GENERATING");

    // ── Agent loop ──────────────────────────────────────────────────
    const result = await runAgent({
      messages,
      tools: buildToolDefinitions(),
      userId,
      sessionId,
      messageId,
      model: harness.model,
      reasoning: harness.reasoning,
      maxTokens: harness.maxTokens,
      emitter,
      sseSend,
      callbacks: {
        onToolStart: (callId, name) => sseSend("tool.start", { callId, name }),
        onToolEnd: (callId, ok, summary) =>
          sseSend("tool.end", { callId, ok, summary }),
      },
      signal,
      askClarification: (q) => askClarification(q, "GENERATING"),
    });

    finalStatus = result.aborted ? "aborted" : result.error ? "error" : "done";
    finalUsage = result.usage;
    finalError = result.error;
    if (result.error) finalErrorCode = "STREAM_ERROR";

    await saveAssistantMessage(
      messageId,
      sessionId,
      userId,
      result.blocks,
      finalStatus,
      {
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(savedSources !== undefined ? { sources: savedSources } : {}),
        toolCalls: result.toolCalls,
      },
    );

    if (finalStatus === "done") {
      void maybeSummarize(sessionId).catch((err: unknown) => {
        logger.warn({ err }, "maybeSummarize fire-and-forget failed");
      });
    }

    if (finalStatus === "done" && session.titleAuto) {
      const priorDoneAssistant = history.some(
        (m) => m.role === "assistant" && m.status === "done",
      );
      if (!priorDoneAssistant) {
        const sessionIdStr = sessionId.toString();
        const assistantText = result.blocks
          .map((b) => blocksToText([b]))
          .join("");
        void generateTitle(sessionIdStr, [
          { role: "user", content: text },
          { role: "assistant", content: assistantText.slice(0, 500) },
        ])
          .then((title) => {
            if (!title) return;
            sseSend("title", { sessionId: sessionIdStr, title });
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, sessionId: sessionIdStr },
              "background title gen failed",
            );
          });
      }
    }

    if (result.aborted) transition("ABORTED");
    else if (result.error) transition("ERROR");
    else transition("DONE");

    return {
      status: finalStatus,
      blocks: result.blocks,
      ...(finalUsage !== undefined ? { usage: finalUsage } : {}),
      ...(finalError !== undefined ? { error: finalError } : {}),
      ...(finalErrorCode !== undefined ? { errorCode: finalErrorCode } : {}),
      ...(clarificationInfo !== undefined
        ? { clarification: clarificationInfo }
        : {}),
    };
  } catch (err) {
    try {
      const partialStatus = signal.aborted ? "aborted" : "error";
      await saveAssistantMessage(
        messageId,
        sessionId,
        userId,
        emitter.blocks,
        partialStatus,
        savedSources !== undefined ? { sources: savedSources } : {},
      );
    } catch (saveErr) {
      logger.error(
        { err: saveErr, assistantId: messageId.toString() },
        "failed to save partial assistant message",
      );
    }

    const code = err instanceof AppError ? err.code : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, sessionId: sessionId.toString() },
      "coordinator runTurn error",
    );

    finalStatus = signal.aborted ? "aborted" : "error";
    finalError = message;
    finalErrorCode = code;

    try {
      if (signal.aborted) transition("ABORTED");
      else transition("ERROR");
    } catch {
      // ignore
    }

    return {
      status: finalStatus,
      blocks: emitter.blocks,
      ...(finalError !== undefined ? { error: finalError } : {}),
      ...(finalErrorCode !== undefined ? { errorCode: finalErrorCode } : {}),
      ...(clarificationInfo !== undefined
        ? { clarification: clarificationInfo }
        : {}),
    };
  }
}
