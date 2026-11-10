import { z } from "zod";

const BoolStr = z.enum(["true", "false"]).transform((v) => v === "true");
const IntStr = z.coerce.number().int();

const EnvSchema = z.object({
  // Core
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: IntStr.positive().default(3000),
  MONGODB_URI: z.string().min(1),
  CLIENT_ORIGIN: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  JWT_SECRET: z.string().min(32),
  DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),

  // NVIDIA
  NVIDIA_API_KEY: z.string().min(1),
  NVIDIA_BASE_URL: z
    .string()
    .min(1)
    .default("https://integrate.api.nvidia.com/v1"),
  MODEL_MAIN: z.string().default("nvidia/nemotron-3-ultra-550b-a55b"),
  MODEL_VISION: z
    .string()
    .default("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
  MODEL_FAST: z.string().default("nvidia/nemotron-3.5-lightning-30b-a3b"),
  MODEL_SAFETY: z.string().default("nvidia/nemotron-3.5-content-safety"),
  SAFETY_ENABLED: BoolStr.default(false),
  SHOW_REASONING: BoolStr.default(false),
  TOOL_MODE: z.enum(["native", "json"]).default("native"),

  // Limits
  MAX_TOOL_ITERATIONS: IntStr.positive().default(8),
  MAX_OUTPUT_TOKENS: IntStr.positive().default(4096),
  HISTORY_TOKEN_BUDGET: IntStr.positive().default(24_000),
  ATTACH_INLINE_TOKEN_BUDGET: IntStr.positive().default(12_000),
  MAX_UPLOAD_MB: IntStr.positive().default(20),
  MAX_OCR_PAGES: IntStr.positive().default(15),
  MAX_DOC_CHARS: IntStr.positive().default(2_000_000),
  PDF_CONCURRENCY: IntStr.positive().default(1),

  // Storage (Cloudflare R2, S3-compatible via Bun.S3Client)
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_PUBLIC_URL: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
