// src/middleware/auth.ts

import type { RequestHandler, Response } from "express";
import { Types } from "mongoose";
import { verifyToken, COOKIE_NAME } from "../auth/tokens.js";
import { UserModel } from "../models/User.js";
import { AppError } from "./error.js";

export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = (req.cookies as Record<string, string | undefined>)[
    COOKIE_NAME
  ];
  if (!token) {
    next(AppError.unauthorized("Missing auth cookie"));
    return;
  }

  try {
    const { sub } = await verifyToken(token);
    if (!Types.ObjectId.isValid(sub)) throw new Error("bad id");

    const exists = await UserModel.exists({ _id: sub });
    if (!exists) throw new Error("user gone");

    res.locals.userId = new Types.ObjectId(sub);
    next();
  } catch {
    next(AppError.unauthorized("Invalid or expired token"));
  }
};

export function getUserId(res: Response): Types.ObjectId {
  return res.locals.userId as Types.ObjectId;
}
