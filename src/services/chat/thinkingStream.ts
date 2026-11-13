// src/services/chat/thinkingStream.ts
export interface ThinkingForwarder {
  push: (delta: string) => void;
  flush: () => void;
  end: () => void;
}

export function createThinkingForwarder(
  send: (event: string, data: unknown) => void,
  opts: { enabled: boolean; flushMs?: number },
): ThinkingForwarder {
  const { enabled, flushMs = 60 } = opts;
  let buffer = "";
  let startedAt: number | null = null;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = (): void => {
    if (buffer.length === 0) return;
    send("thinking.delta", { delta: buffer });
    buffer = "";
  };

  const scheduleFlush = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      doFlush();
    }, flushMs);
  };

  return {
    push: (delta: string): void => {
      if (!enabled || ended) return;
      if (startedAt === null) startedAt = Date.now();
      buffer += delta;
      scheduleFlush();
    },
    flush: (): void => {
      if (!enabled) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      doFlush();
    },
    end: (): void => {
      if (!enabled || ended) return;
      ended = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      doFlush();
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      send("thinking.end", { durationMs });
    },
  };
}
