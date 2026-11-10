// src/config/logger.ts

import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.NODE_ENV === "development" ? "debug" : "info",
  base: { service: "genui-backend" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "NVIDIA_API_KEY",
      "JWT_SECRET",
    ],
    censor: "[REDACTED]",
  },
});
