// src/routes/files.ts

import { Router } from "express";
import {
  presignUpload,
  completeUpload,
  getFileMeta,
  downloadFile,
  getFileContent,
  deleteFile,
} from "../controllers/filesController.js";
import { filesLimiter } from "../middleware/rateLimit.js";

export const filesRouter = Router();

filesRouter.post("/presign", filesLimiter, presignUpload);
filesRouter.post("/:id/complete", filesLimiter, completeUpload);
filesRouter.get("/:id", getFileMeta);
filesRouter.get("/:id/download", filesLimiter, downloadFile);
filesRouter.get("/:id/content", filesLimiter, getFileContent);
filesRouter.delete("/:id", deleteFile);
