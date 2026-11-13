// src/services/orchestrator/types.ts
import type { Types } from "mongoose";
import type { Block } from "../blocks/schemas.js";
import type { ChatMessage, Usage } from "../llm/nvidiaClient.js";

export type Phase =
  | "IDLE"
  | "CLARIFYING"
  | "RETRIEVING"
  | "GENERATING"
  | "DONE"
  | "ABORTED"
  | "ERROR";

export type SseSend = (event: string, data: unknown) => void;

export interface OrchestratorHooks {
  /** Phase 1 tidak mengisi. Phase 2: retrieval RAG. */
  retrieveContext?: (input: {
    sessionId: Types.ObjectId;
    userId: Types.ObjectId;
    text: string;
    attachmentIds: string[];
    signal: AbortSignal;
  }) => Promise<{
    systemMessages: ChatMessage[];
    sources: unknown[];
  } | null>;
}

export interface RunTurnInput {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  /** Id untuk pesan assistant yang akan dipersist. */
  messageId: Types.ObjectId;
  /** Id pesan user yang sudah dipersist controller (untuk exclusion di history). */
  userMessageId: Types.ObjectId;
  text: string;
  attachmentIds: string[];
  sseSend: SseSend;
  signal: AbortSignal;
  hooks?: OrchestratorHooks;
}

export interface RunTurnResult {
  status: "done" | "aborted" | "error";
  blocks: Block[];
  usage?: Usage;
  /** Pesan error untuk SSE `error` event (bila status=error). */
  error?: string;
  /** Kode error untuk SSE (e.g. BAD_REQUEST, STREAM_ERROR). */
  errorCode?: string;
  clarification?: {
    questionId: string;
    question: string;
    answer: string[];
  };
}
