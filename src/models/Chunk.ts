import mongoose, { Schema, Types, type Model } from "mongoose";

export interface IChunk {
  fileId: Types.ObjectId;
  sessionId: Types.ObjectId;
  idx: number;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

const chunkSchema = new Schema<IChunk>(
  {
    fileId: { type: Types.ObjectId, ref: "FileDoc", required: true },
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    idx: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { timestamps: true },
);

chunkSchema.index({ fileId: 1, idx: 1 });
chunkSchema.index(
  { text: "text" },
  { default_language: "none", name: "chunk_text" },
);

export const ChunkModel: Model<IChunk> =
  (mongoose.models.Chunk as Model<IChunk>) ??
  mongoose.model<IChunk>("Chunk", chunkSchema);
