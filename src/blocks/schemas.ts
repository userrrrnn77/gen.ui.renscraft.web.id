import { z } from "zod";

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const TextBlock = z.object({
  type: z.literal("text"),
  markdown: z.string(),
});

export const CodeBlock = z.object({
  type: z.literal("code"),
  language: z.string().default("text"),
  filename: z.string().optional(),
  content: z.string(),
});

export const FileBlock = z.object({
  type: z.literal("file"),
  fileId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  version: z.number().default(1),
  preview: z.enum(["code", "text", "image", "pdf", "none"]),
  note: z.string().optional(),
});

export const ImageBlock = z.object({
  type: z.literal("image"),
  fileId: z.string(),
  alt: z.string().optional(),
});

export const TableBlock = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        align: z.enum(["left", "right", "center"]).optional(),
      }),
    )
    .min(1)
    .max(20),
  rows: z.array(z.record(z.string(), Cell)).max(200),
});

export const ChartBlock = z.object({
  type: z.literal("chart"),
  kind: z.enum(["bar", "line", "area", "pie", "scatter"]),
  title: z.string().optional(),
  xKey: z.string(),
  series: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
  data: z.array(z.record(z.string(), Cell)).max(500),
});

export const CardBlock = z.object({
  type: z.literal("card"),
  title: z.string(),
  subtitle: z.string().optional(),
  markdown: z.string().optional(),
  tone: z
    .enum(["neutral", "info", "success", "warning", "danger"])
    .default("neutral"),
  actions: z
    .array(
      z.object({
        label: z.string(),
        prompt: z.string(),
      }),
    )
    .max(4)
    .optional(),
});

export const ChoicesBlock = z.object({
  type: z.literal("choices"),
  question: z.string(),
  multi: z.boolean().default(false),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(2)
    .max(6),
});

export const Block = z.discriminatedUnion("type", [
  TextBlock,
  CodeBlock,
  FileBlock,
  ImageBlock,
  TableBlock,
  ChartBlock,
  CardBlock,
  ChoicesBlock,
]);

export type Block = z.infer<typeof Block>;
