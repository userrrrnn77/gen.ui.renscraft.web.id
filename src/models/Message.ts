// src/models/Message.ts

import mongoose, {
  Schema,
  Types,
  type Model,
  type HydratedDocument,
  type SchemaDefinitionProperty,
} from "mongoose";
import { Block } from "../services/blocks/schemas.js";
import { z } from "zod";

export interface IToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface IMessageSource {
  n: number;
  fileId: string;
  name: string;
  idx: number;
  snippet: string;
}

export interface IMessageLlm {
  toolCalls?: IToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolResult?: string;
}

export interface ILlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface IMessage {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MessageRole;
  blocks: Block[];
  attachmentIds: Types.ObjectId[];
  llm?: IMessageLlm;
  status: MessageStatus;
  usage?: ILlmUsage;
  sources?: IMessageSource[];
  tokenEstimate: number;
  summarized: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageRole = "user" | "assistant" | "tool";
export type MessageStatus = "streaming" | "done" | "aborted" | "error";

export interface IMessage {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MessageRole;
  blocks: Block[];
  attachmentIds: Types.ObjectId[];
  llm?: IMessageLlm;
  status: MessageStatus;
  usage?: ILlmUsage;
  tokenEstimate: number;
  summarized: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const toolCallSchema = new Schema<IToolCall>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    argsJson: { type: String, required: true },
  },
  { _id: false },
);

const llmSchema = new Schema<IMessageLlm>(
  {
    toolCalls: { type: [toolCallSchema], default: undefined },
    toolCallId: String,
    toolName: String,
    toolResult: String,
  },
  { _id: false },
);

const usageSchema = new Schema<ILlmUsage>(
  {
    prompt_tokens: Number,
    completion_tokens: Number,
    total_tokens: Number,
  },
  { _id: false },
);

const sourceSchema = new Schema<IMessageSource>(
  {
    n: { type: Number, required: true },
    fileId: { type: String, required: true },
    name: { type: String, required: true },
    idx: { type: Number, required: true },
    snippet: { type: String, required: true },
  },
  { _id: false },
);

const messageSchema = new Schema<IMessage>(
  {
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    userId: { type: Types.ObjectId, ref: "User", required: true },
    role: {
      type: String,
      enum: ["user", "assistant", "tool"],
      required: true,
    },
    // Mongoose tidak punya padanan tipe untuk "array Mixed yang di-declare
    // sebagai Block[]". Cast deklarasi field; validasi runtime tetap
    // dijalankan lewat pre('save') memakai zod.
    blocks: {
      type: [Schema.Types.Mixed],
      default: [],
    } as unknown as SchemaDefinitionProperty<Block[]>,
    attachmentIds: { type: [Types.ObjectId], ref: "FileDoc", default: [] },
    llm: { type: llmSchema, default: undefined },
    status: {
      type: String,
      enum: ["streaming", "done", "aborted", "error"],
      default: "done",
    },
    usage: { type: usageSchema, default: undefined },
    sources: { type: [sourceSchema], default: undefined },
    tokenEstimate: { type: Number, default: 0 },
    summarized: { type: Boolean, default: false },
  },
  { timestamps: true },
);

messageSchema.index({ sessionId: 1, createdAt: 1 });
messageSchema.index({ attachmentIds: 1 });

const MAX_TOOL_RESULT_CHARS = 8192;

messageSchema.pre("save", function (this: HydratedDocument<IMessage>) {
  if (Array.isArray(this.blocks) && this.blocks.length > 0) {
    const validated: Block[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const r = Block.safeParse(this.blocks[i]);
      if (!r.success) {
        throw new Error(
          `Invalid block at index ${i}: ${JSON.stringify(z.treeifyError(r.error))}`,
        );
      }
      validated.push(r.data);
    }
    this.blocks = validated;
    this.markModified("blocks");
  }

  if (
    this.llm?.toolResult &&
    this.llm.toolResult.length > MAX_TOOL_RESULT_CHARS
  ) {
    this.llm.toolResult = this.llm.toolResult.slice(0, MAX_TOOL_RESULT_CHARS);
    this.markModified("llm.toolResult");
  }
});

export type MessageDoc = HydratedDocument<IMessage>;

export const MessageModel: Model<IMessage> =
  (mongoose.models.Message as Model<IMessage>) ??
  mongoose.model<IMessage>("Message", messageSchema);
