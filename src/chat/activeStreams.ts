// src/chat/activeStreams.ts

const active = new Set<AbortController>();

export function registerStream(ac: AbortController): void {
  active.add(ac);
}

export function unregisterStream(ac: AbortController): void {
  active.delete(ac);
}

export function abortAllStreams(): void {
  for (const ac of active) {
    try {
      ac.abort();
    } catch {
      // ignore
    }
  }
}

export function activeStreamCount(): number {
  return active.size;
}
