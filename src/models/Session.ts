import mongoose, {
  Schema,
  Types,
  type InferSchemaType,
  type Model,
} from "mongoose";

const sessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    title: { type: String, default: "New Chat", trim: true },
    titleAuto: { type: Boolean, default: true },
    summary: { type: String, default: "" },
    summaryUpToMessageId: {
      type: Types.ObjectId,
      ref: "Message",
      default: null,
    },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    lastMessageAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

sessionSchema.index({ userId: 1, lastMessageAt: -1 });

export type ISession = InferSchemaType<typeof sessionSchema>;

export const SessionModel: Model<ISession> =
  (mongoose.models.Session as Model<ISession>) ??
  mongoose.model<ISession>("Session", sessionSchema);
