// src/pdf/engine.ts

import { chromium, type Browser } from "playwright";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export interface PdfEngine {
  render(html: string): Promise<Buffer>;
}

const MAX_HTML_BYTES = 500 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 60_000;

class PlaywrightPdfEngine implements PdfEngine {
  private browser: Browser | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private waiters: Array<() => void> = [];

  private async acquireSlot(): Promise<void> {
    if (this.inflight < env.PDF_CONCURRENCY) {
      this.inflight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inflight++;
  }

  private releaseSlot(): void {
    this.inflight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      this.resetIdleTimer();
      return this.browser;
    }
    this.browser = null;
    try {
      this.browser = await chromium.launch({ headless: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Chromium launch failed. Install: bunx playwright install chromium --with-deps. Detail: ${msg}`,
      );
    }
    this.resetIdleTimer();
    return this.browser;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const b = this.browser;
    this.browser = null;
    if (b) {
      await b.close().catch((err: unknown) => {
        logger.warn({ err }, "browser close failed");
      });
    }
  }

  async render(html: string): Promise<Buffer> {
    const htmlBytes = Buffer.byteLength(html, "utf-8");
    if (htmlBytes > MAX_HTML_BYTES) {
      throw new Error(
        `HTML input terlalu besar: ${htmlBytes} > ${MAX_HTML_BYTES}`,
      );
    }

    await this.acquireSlot();
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        let abortedCount = 0;
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (
            url.startsWith("data:") ||
            url.startsWith("blob:") ||
            url === "about:blank"
          ) {
            return route.continue();
          }
          abortedCount++;
          return route.abort();
        });

        const page = await context.newPage();
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error("PDF render timeout")),
              RENDER_TIMEOUT_MS + 2_000,
            );
            t.unref?.();
          });
          await Promise.race([
            page.setContent(html, {
              waitUntil: "load",
              timeout: RENDER_TIMEOUT_MS,
            }),
            timeoutPromise,
          ]);

          const pdfOut = await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
          });
          const pdfBuf: Buffer = Buffer.isBuffer(pdfOut)
            ? pdfOut
            : Buffer.from(pdfOut);

          if (pdfBuf.length > MAX_PDF_BYTES) {
            throw new Error(
              `PDF output terlalu besar: ${pdfBuf.length} > ${MAX_PDF_BYTES}`,
            );
          }
          if (abortedCount > 0) {
            logger.warn(
              { abortedCount },
              "pdf render menghentikan request eksternal",
            );
          }
          return pdfBuf;
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      this.releaseSlot();
      this.resetIdleTimer();
    }
  }
}

let engine: PlaywrightPdfEngine | null = null;

export function getPdfEngine(): PdfEngine {
  if (!engine) engine = new PlaywrightPdfEngine();
  return engine;
}

export async function closePdfEngine(): Promise<void> {
  if (engine) {
    await engine.close();
    engine = null;
  }
}
