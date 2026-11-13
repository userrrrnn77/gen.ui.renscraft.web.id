// src/services/chat/sse.ts
import type { Response } from "express";

export interface SseSender {
  send: (event: string, data: unknown) => void;
  ping: () => void;
}

export function setupSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function createSseSender(res: Response): SseSender {
  const writable = (): boolean => !res.writableEnded && !res.destroyed;

  return {
    send: (event, data) => {
      if (!writable()) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected mid-write; ignore.
      }
    },
    ping: () => {
      if (!writable()) return;
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    },
  };
}

export function startPing(
  sse: SseSender,
  intervalMs = 15_000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => sse.ping(), intervalMs);
  timer.unref?.();
  return timer;
}
