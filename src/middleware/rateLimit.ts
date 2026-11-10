// src/middleware/rateLimit.ts

import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const isDev = env.NODE_ENV !== "production";

const baseOptions = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
};

export const globalLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: isDev ? 1000 : 300,
  message: { error: { code: "RATE_LIMIT", message: "Too many requests" } },
});

export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: isDev ? 50 : 10,
  message: { error: { code: "RATE_LIMIT", message: "Too many auth attempts" } },
});

export const messageLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: isDev ? 100 : 20,
  message: { error: { code: "RATE_LIMIT", message: "Too many messages" } },
});
