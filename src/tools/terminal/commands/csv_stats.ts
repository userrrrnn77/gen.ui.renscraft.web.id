// src/tools/terminal/commands/csv_stats.ts

import { z } from "zod";
import Papa from "papaparse";
import { registerCommand } from "../registry.js";

const CsvStatsArgs = z.object({
  fileId: z.string(),
});

registerCommand({
  name: "csv_stats",
  description:
    'Hitung statistik per kolom numerik dari file CSV: count/min/max/mean. Args: {"fileId":"..."}.',
  argsSchema: CsvStatsArgs,
  timeoutMs: 5000,
  async run(args, ctx) {
    const a = CsvStatsArgs.parse(args);
    const text = await ctx.readFileText(a.fileId);

    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    const rows = parsed.data;
    const headers = parsed.meta.fields ?? [];

    const columns: Record<string, unknown> = {};
    for (const h of headers) {
      const nums: number[] = [];
      let nonNumeric = 0;
      for (const row of rows) {
        const v = row[h];
        if (v === "" || v === undefined || v === null) continue;
        const n = Number(v);
        if (Number.isFinite(n)) nums.push(n);
        else nonNumeric++;
      }
      if (nums.length === 0) continue;
      let sum = 0;
      let min = nums[0];
      let max = nums[0];
      for (const n of nums) {
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      columns[h] = {
        count: nums.length,
        nonNumeric,
        min,
        max,
        mean: sum / nums.length,
      };
    }

    return {
      ok: true,
      data: { rows: rows.length, columns },
    };
  },
});
