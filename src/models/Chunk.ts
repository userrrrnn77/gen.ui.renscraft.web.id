// src/models/Chunk.ts

import mongoose, { Schema, Types, type Model } from "mongoose";

export interface IChunk {
  fileId: Types.ObjectId;
  sessionId: Types.ObjectId;
  idx: number;
  text: string;
  /** Vector embedding (float32 diserialisasi sebagai number[]). */
  embedding?: number[];
  /** Nama model yang menghasilkan embedding ini (audit / re-embed). */
  embeddingModel?: string;
  /** Timestamp saat embedding berhasil disimpan. Null/undefined = belum. */
  embeddedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const chunkSchema = new Schema<IChunk>(
  {
    fileId: { type: Types.ObjectId, ref: "FileDoc", required: true },
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    idx: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], default: undefined },
    embeddingModel: String,
    embeddedAt: Date,
  },
  { timestamps: true },
);

chunkSchema.index({ fileId: 1, idx: 1 });
chunkSchema.index(
  { text: "text" },
  { default_language: "none", name: "chunk_text" },
);
// Index untuk backfill / audit: query { embeddedAt: { $exists: false } }.
chunkSchema.index({ embeddedAt: 1 }, { sparse: true });

export const ChunkModel: Model<IChunk> =
  (mongoose.models.Chunk as Model<IChunk>) ??
  mongoose.model<IChunk>("Chunk", chunkSchema);
