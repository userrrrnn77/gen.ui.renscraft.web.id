import mongoose, { Schema, Types, type Model } from "mongoose";

export interface IToolRun {
  sessionId: Types.ObjectId;
  messageId?: Types.ObjectId | null;
  tool: string;
  command?: string;
  argsHash?: string;
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  createdAt: Date;
  updatedAt: Date;
}

const toolRunSchema = new Schema<IToolRun>(
  {
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    messageId: { type: Types.ObjectId, ref: "Message", default: null },
    tool: { type: String, required: true },
    command: String,
    argsHash: String,
    ok: { type: Boolean, required: true },
    exitCode: Number,
    durationMs: { type: Number, required: true },
  },
  { timestamps: true },
);

toolRunSchema.index({ sessionId: 1, createdAt: -1 });

export const ToolRunModel: Model<IToolRun> =
  (mongoose.models.ToolRun as Model<IToolRun>) ??
  mongoose.model<IToolRun>("ToolRun", toolRunSchema);
