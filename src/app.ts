// src/app.ts

import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { AppError } from "./middleware/error.js";
import indexRoutes from "./routes/index.js";
import path from "node:path";

export function buildApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: false, // Matikan CSP saat development harness agar CDN bisa jalan
    }),
  );

  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(pinoHttp({ logger }));

  app.use(express.static(path.join(process.cwd(), "public")));

  app.use("/api", indexRoutes);

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  };
  app.use(notFound);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) return;

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid input",
          details: err.issues,
        },
      });
      return;
    }

    logger.error({ err }, "unhandled error");
    const message =
      env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : String(err);
    res.status(500).json({
      error: { code: "INTERNAL", message },
    });
  };
  app.use(errorHandler);

  return app;
}
