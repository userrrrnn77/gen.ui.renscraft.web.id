// src/models/FileDoc.ts
import mongoose, { Schema, Types, type Model } from "mongoose";

export type FileOrigin = "upload" | "generated";
export type FileStatus = "pending" | "processing" | "ready" | "failed";
export type FileIndexStatus =
  | "disabled"
  | "pending"
  | "indexing"
  | "ready"
  | "failed";
export type StorageDriver = "r2" | "local" | "cloudinary";

export interface IFileDocStorage {
  driver: StorageDriver;
  key: string;
  url?: string;
}

export interface IFileDocExtract {
  kind: string;
  chars?: number;
  pages?: number;
  sheets?: number;
  truncated?: boolean;
}

export interface IFileDocDigest {
  summary?: string;
  ocrText?: string;
  json?: unknown;
}

export interface IFileDoc {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  origin: FileOrigin;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  version: number;
  parentFileId?: Types.ObjectId | null;
  storage: IFileDocStorage;
  status: FileStatus;
  indexStatus?: FileIndexStatus;
  error?: string;
  extract?: IFileDocExtract;
  digest?: IFileDocDigest;
  summaryLine?: string;
  createdAt: Date;
  updatedAt: Date;
}

const storageSchema = new Schema<IFileDocStorage>(
  {
    driver: {
      type: String,
      enum: ["r2", "local", "cloudinary"],
      default: "r2",
      required: true,
    },
    key: { type: String, required: true },
    url: String,
  },
  { _id: false },
);

const extractSchema = new Schema<IFileDocExtract>(
  {
    kind: { type: String, required: true },
    chars: Number,
    pages: Number,
    sheets: Number,
    truncated: Boolean,
  },
  { _id: false },
);

const digestSchema = new Schema<IFileDocDigest>(
  {
    summary: String,
    ocrText: String,
    json: Schema.Types.Mixed,
  },
  { _id: false },
);

const fileDocSchema = new Schema<IFileDoc>(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    origin: { type: String, enum: ["upload", "generated"], required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, default: "" },
    version: { type: Number, default: 1 },
    parentFileId: { type: Types.ObjectId, ref: "FileDoc", default: null },
    storage: { type: storageSchema, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    indexStatus: {
      type: String,
      enum: ["disabled", "pending", "indexing", "ready", "failed"],
      default: undefined,
    },
    error: String,
    extract: { type: extractSchema, default: undefined },
    digest: { type: digestSchema, default: undefined },
    summaryLine: String,
  },
  { timestamps: true },
);

fileDocSchema.index({ sessionId: 1, createdAt: 1 });
fileDocSchema.index({ status: 1, createdAt: 1 });

export const FileDocModel: Model<IFileDoc> =
  (mongoose.models.FileDoc as Model<IFileDoc>) ??
  mongoose.model<IFileDoc>("FileDoc", fileDocSchema);
