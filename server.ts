// src/server.ts

import mongoose from "mongoose";
import { env } from "./src/config/env.js";
import { logger } from "./src/config/logger.js";
import { connectToDatabase } from "./src/db/connect.js";
import { buildApp } from "./src/app.js";

async function bootstrap(): Promise<void> {
  await connectToDatabase();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");

    server.close((closeErr) => {
      if (closeErr) logger.error({ err: closeErr }, "http server close error");
    });

    try {
      await mongoose.disconnect();
    } catch (err) {
      logger.error({ err }, "mongo disconnect error");
    }

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, "bootstrap failed");
  process.exit(1);
});
