// src/config/redis.ts

import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

if (!env.REDIS_URL) {
  logger.warn(
    "REDIS_URL tidak diset. Rate limit tidak akan berjalan multi-instance.",
  );
}

export const redisClient = new Redis(env.REDIS_URL!, {
  // Upstash TLS wajib diset true jika menggunakan rediss://
  tls: env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
  maxRetriesPerRequest: 3,
  // Upstash free tier akan memutus koneksi yang idle terlalu lama
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redisClient.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

redisClient.on("connect", () => {
  logger.info("Connected to Redis (Upstash)");
});
