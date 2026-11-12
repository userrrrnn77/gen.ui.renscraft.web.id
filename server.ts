// src/server.ts

import mongoose from "mongoose";
import { env } from "./src/config/env.js";
import { logger } from "./src/config/logger.js";
import { connectToDatabase } from "./src/db/connect.js";
import { buildApp } from "./src/app.js";
import { closePdfEngine } from "./src/pdf/engine.js";
import { startCleanup, stopCleanup } from "./src/jobs/cleanup.js";
import { abortAllStreams, activeStreamCount } from "./src/chat/activeStreams.js";
import { drainIngestion } from "./src/ingest/index.js";

async function bootstrap(): Promise<void> {
  await connectToDatabase();
  startCleanup();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal, activeStreams: activeStreamCount() },
      "shutdown initiated",
    );

    const forceTimer = setTimeout(() => {
      logger.fatal("forced exit after 15s");
      process.exit(1);
    }, 15_000);
    forceTimer.unref?.();

    // 1. Stop accepting new connections
    server.close((closeErr) => {
      if (closeErr) logger.error({ err: closeErr }, "http server close error");
    });

    // 2. Abort active streams, wait up to 10s
    abortAllStreams();
    const drainDeadline = Date.now() + 10_000;
    while (activeStreamCount() > 0 && Date.now() < drainDeadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (activeStreamCount() > 0) {
      logger.warn(
        { remaining: activeStreamCount() },
        "streams still active after drain",
      );
    }

    // 3. Drain ingestion
    try {
      await drainIngestion(10_000);
    } catch (err) {
      logger.error({ err }, "drainIngestion error");
    }

    // 4. Close PDF engine
    try {
      await closePdfEngine();
    } catch (err) {
      logger.error({ err }, "closePdfEngine error");
    }

    // 5. Stop cleanup
    stopCleanup();

    // 6. Mongo
    try {
      await mongoose.disconnect();
    } catch (err) {
      logger.error({ err }, "mongo disconnect error");
    }

    clearTimeout(forceTimer);
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
