// src/services/tools/ui.ts

import { z } from "zod";
import { registerTool, okResult } from "./registry.js";

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// ─── render_table ──────────────────────────────────────────────────────────

const RenderTableSchema = z.object({
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

registerTool({
  name: "render_table",
  kind: "ui",
  description:
    "Render tabel interaktif untuk data tabular. Gunakan untuk data >5 baris atau saat user minta tabel/perbandingan.",
  schema: RenderTableSchema,
  async run(args, ctx) {
    const a = RenderTableSchema.parse(args);
    ctx.emitBlock({
      type: "table",
      ...(a.title !== undefined ? { title: a.title } : {}),
      columns: a.columns,
      rows: a.rows,
    });
    return okResult({
      rendered: "table",
      rows: a.rows.length,
      columns: a.columns.length,
    });
  },
});

// ─── render_chart ──────────────────────────────────────────────────────────

const RenderChartSchema = z.object({
  kind: z.enum(["bar", "line", "area", "pie", "scatter"]),
  title: z.string().optional(),
  xKey: z.string(),
  series: z
    .array(z.object({ key: z.string(), label: z.string().optional() }))
    .min(1)
    .max(8),
  data: z.array(z.record(z.string(), Cell)).max(500),
});

registerTool({
  name: "render_chart",
  kind: "ui",
  description:
    "Render chart (bar/line/area/pie/scatter) dari data numerik. Gunakan untuk perbandingan angka atau tren.",
  schema: RenderChartSchema,
  async run(args, ctx) {
    const a = RenderChartSchema.parse(args);
    ctx.emitBlock({
      type: "chart",
      kind: a.kind,
      ...(a.title !== undefined ? { title: a.title } : {}),
      xKey: a.xKey,
      series: a.series,
      data: a.data,
    });
    return okResult({ rendered: "chart", kind: a.kind, points: a.data.length });
  },
});

// ─── render_card ───────────────────────────────────────────────────────────

const RenderCardSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  markdown: z.string().optional(),
  tone: z.enum(["neutral", "info", "success", "warning", "danger"]).optional(),
  actions: z
    .array(z.object({ label: z.string(), prompt: z.string() }))
    .max(4)
    .optional(),
});

registerTool({
  name: "render_card",
  kind: "ui",
  description:
    "Render card (judul + markdown + tone + tombol aksi). Gunakan untuk highlight info penting atau menyajikan pilihan tindakan.",
  schema: RenderCardSchema,
  async run(args, ctx) {
    const a = RenderCardSchema.parse(args);
    ctx.emitBlock({
      type: "card",
      title: a.title,
      ...(a.subtitle !== undefined ? { subtitle: a.subtitle } : {}),
      ...(a.markdown !== undefined ? { markdown: a.markdown } : {}),
      tone: a.tone ?? "neutral",
      ...(a.actions !== undefined ? { actions: a.actions } : {}),
    });
    return okResult({ rendered: "card", title: a.title });
  },
});

// ─── render_choices ────────────────────────────────────────────────────────

const RenderChoicesSchema = z.object({
  question: z.string(),
  options: z
    .array(z.object({ label: z.string(), value: z.string().optional() }))
    .min(2)
    .max(6),
  multi: z.boolean().optional(),
});

registerTool({
  name: "render_choices",
  kind: "ui",
  description:
    "Tampilkan pertanyaan pilihan ke user. Giliran akan diakhiri; klik user jadi pesan berikutnya. Gunakan HANYA jika benar-benar ambigu.",
  schema: RenderChoicesSchema,
  async run(args, ctx) {
    const a = RenderChoicesSchema.parse(args);
    ctx.emitBlock({
      type: "choices",
      question: a.question,
      multi: a.multi ?? false,
      options: a.options,
    });
    return {
      ...okResult({ rendered: "choices", options: a.options.length }),
      endTurn: true,
    };
  },
});
