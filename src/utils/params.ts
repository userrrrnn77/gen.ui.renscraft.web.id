// src/utils/params.ts

import { Types } from "mongoose";
import { AppError } from "../middleware/error.js";

export function parseObjectIdParam(raw: string | string[] | undefined): string {
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !Types.ObjectId.isValid(id)) throw AppError.notFound();
  return id;
}
