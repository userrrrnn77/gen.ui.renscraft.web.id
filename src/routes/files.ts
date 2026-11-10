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

export const filesRouter = Router();

filesRouter.post("/presign", presignUpload);
filesRouter.post("/:id/complete", completeUpload);
filesRouter.get("/:id", getFileMeta);
filesRouter.get("/:id/download", downloadFile);
filesRouter.get("/:id/content", getFileContent);
filesRouter.delete("/:id", deleteFile);
