// src/middleware/rateLimit.ts

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import {
  RedisStore,
  type SendCommandFn,
  type RedisReply,
} from "rate-limit-redis";
import { env } from "../config/env.js";
import { redisClient } from "../config/redis.js";

const isDev = env.NODE_ENV !== "production";

const sendCommand: SendCommandFn = (...args: string[]) => {
  const [command, ...rest] = args;
  return redisClient.call(command, ...rest) as Promise<RedisReply>;
};

// Factory: tiap limiter dapat instance RedisStore baru + prefix unik
const createRateLimitOptions = (prefix: string) => ({
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand,
    prefix: `genui:ratelimit:${prefix}:`,
  }),
});

function userOrIpKey(req: Request): string {
  const locals = (req.res?.locals ?? {}) as Record<string, unknown>;
  const userId = locals.userId;
  if (userId !== undefined && userId !== null) {
    return `u:${String(userId)}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? "::1")}`;
}

export const globalLimiter = rateLimit({
  ...createRateLimitOptions("global"),
  windowMs: 60_000,
  limit: isDev ? 1000 : 300,
  message: { error: { code: "RATE_LIMIT", message: "Too many requests" } },
});

export const authLimiter = rateLimit({
  ...createRateLimitOptions("auth"),
  windowMs: 60_000,
  limit: isDev ? 50 : 10,
  message: { error: { code: "RATE_LIMIT", message: "Too many auth attempts" } },
});

export const messageLimiter = rateLimit({
  ...createRateLimitOptions("message"),
  windowMs: 60_000,
  limit: isDev ? 100 : 20,
  keyGenerator: userOrIpKey,
  message: { error: { code: "RATE_LIMIT", message: "Too many messages" } },
});

export const filesLimiter = rateLimit({
  ...createRateLimitOptions("files"),
  windowMs: 60_000,
  limit: isDev ? 100 : 30,
  keyGenerator: userOrIpKey,
  message: { error: { code: "RATE_LIMIT", message: "Too many file requests" } },
});
