// src/db/connect.ts

import mongoose, { type ConnectOptions } from "mongoose";
import { env } from "../config/env.js";

// ─── Configuration ──────────────────────────────────────────────────────────

// Jumlah total percobaan, termasuk percobaan pertama.
const MAX_ATTEMPTS = 5;

// Jeda awal sebelum retry.
const RETRY_DELAY_MS = 3000;
const RETRY_MULTIPLIER = 2;
const MAX_RETRY_DELAY_MS = 10000;

const DB_OPTIONS: ConnectOptions = {
  // Batas waktu untuk membangun koneksi TCP ke satu server.
  connectTimeoutMS: 10000,

  // Maksimal koneksi socket dalam pool.
  maxPoolSize: 10,

  // serverSelectionTimeoutMS sengaja tidak diubah.
  // Default MongoDB driver: 30000 ms.
  //
  // socketTimeoutMS juga sengaja tidak ditetapkan agar operasi
  // tidak terputus hanya karena socket tidak aktif selama
  // interval pendek yang arbitrer.
};

// Menyimpan promise koneksi yang sedang berjalan agar pemanggilan
// bersamaan tidak memulai beberapa proses koneksi awal.
let connectionPromise: Promise<typeof mongoose> | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getConnectionInfo(): { host: string; database: string } {
  return {
    host: mongoose.connection.host || "unknown",
    database: mongoose.connection.name || "unknown",
  };
}

// ─── Connection Lifecycle ───────────────────────────────────────────────────

// Listener didaftarkan satu kali ketika modul dimuat.
mongoose.connection.on("disconnected", () => {
  console.warn("[DB] MongoDB disconnected.");
});

mongoose.connection.on("reconnected", () => {
  console.info("[DB] MongoDB reconnected.");
});

mongoose.connection.on("error", (error: unknown) => {
  console.error(`[DB] MongoDB connection error: ${getErrorMessage(error)}`);
});

// ─── Retry Connection ───────────────────────────────────────────────────────

async function connectWithRetry(uri: string): Promise<typeof mongoose> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const conn = await mongoose.connect(uri, DB_OPTIONS);
      const { host, database } = getConnectionInfo();

      console.info(
        `[DB] MongoDB connected successfully | host=${host} | database=${database}`,
      );

      return conn;
    } catch (error) {
      const message = getErrorMessage(error);

      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[DB] Connection failed after ${MAX_ATTEMPTS} attempts. ` +
            `Last error: ${message}`,
        );

        // Biarkan server.js menangani kegagalan startup.
        throw error;
      }

      const delay = Math.min(
        RETRY_DELAY_MS * RETRY_MULTIPLIER ** (attempt - 1),
        MAX_RETRY_DELAY_MS,
      );

      console.warn(
        `[DB] Connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ` +
          `${message}. Retrying in ${delay} ms...`,
      );

      await wait(delay);
    }
  }

  // Pengaman untuk menjamin fungsi tidak selesai tanpa koneksi.
  throw new Error("[DB] Connection attempts exhausted.");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connectToDatabase(): Promise<typeof mongoose> {
  // Hindari membuat koneksi awal baru ketika sudah terhubung.
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // URI sudah divalidasi zod di config/env.ts — pasti ada & non-empty.
  const uri = env.MONGODB_URI.trim();

  // Semua pemanggil bersamaan berbagi promise yang sama.
  if (!connectionPromise) {
    connectionPromise = connectWithRetry(uri).finally(() => {
      // Reset setelah selesai agar pemanggilan berikutnya
      // bisa mencoba kembali jika koneksi awal gagal.
      connectionPromise = null;
    });
  }

  return connectionPromise;
}
