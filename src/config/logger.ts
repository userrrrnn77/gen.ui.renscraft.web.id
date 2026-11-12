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
  // Tambahin transport pino-pretty khusus buat environment development
  ...(env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard", // Format waktu jadi YYYY-MM-DD HH:MM:SS
        ignore: "pid,hostname", // Sembunyiin PID dan hostname biar log nggak kepanjangan
        singleLine: true, // Opsional: bikin log satu baris aja kalau message-nya panjang
      },
    },
  }),
});
