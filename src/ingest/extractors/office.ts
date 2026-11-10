// src/ingest/extractors/office.ts

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';

export interface OfficeExtract {
  kind: string;
  text: string;
  pages?: number;
  sheets?: number;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

function toMarkdownTable(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): string {
  if (headers.length === 0) return '';
  const esc = (v: unknown): string =>
    v === null || v === undefined
      ? ''
      : String(v).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r) => `| ${headers.map((h) => esc(r[h])).join(' | ')} |`)
    .join('\n');
  return `${head}\n${sep}\n${body}`;
}

// ─── DOCX ──────────────────────────────────────────────────────────────────

export async function extractDocx(buf: Buffer): Promise<OfficeExtract> {
  const result = await mammoth.convertToHtml({ buffer: buf });
  const md = turndown.turndown(result.value);
  return { kind: 'docx', text: md };
}

// ─── XLSX ──────────────────────────────────────────────────────────────────

const XLSX_MAX_INLINE_ROWS = 200;

export async function extractXlsx(buf: Buffer): Promise<OfficeExtract> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);

  const parts: string[] = [];
  let sheetCount = 0;

  wb.eachSheet((sheet) => {
    sheetCount++;
    const headers: string[] = [];
    const rows: Array<Record<string, unknown>> = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        row.eachCell((cell, colNumber) => {
          headers[colNumber - 1] =
            cell.value === null || cell.value === undefined
              ? `col${colNumber}`
              : String(cell.value);
        });
        return;
      }
      if (rows.length >= XLSX_MAX_INLINE_ROWS) return;
      const rec: Record<string, unknown> = {};
      row.eachCell((cell, colNumber) => {
        const key = headers[colNumber - 1] ?? `col${colNumber}`;
        rec[key] = cell.value;
      });
      rows.push(rec);
    });

    parts.push(`### Sheet: ${sheet.name}\n\n${toMarkdownTable(headers, rows)}`);
  });

  return { kind: 'xlsx', text: parts.join('\n\n'), sheets: sheetCount };
}

// ─── XLS (legacy) ─────────────────────────────────────────────────────────

export function extractXls(buf: Buffer): OfficeExtract {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`### Sheet: ${name}\n\n${csv}`);
  }
  return { kind: 'xls', text: parts.join('\n\n'), sheets: wb.SheetNames.length };
}

// ─── CSV → teks (per PRD: baca UTF-8 apa adanya, biar model yang urus) ────

export function extractCsv(buf: Buffer): OfficeExtract {
  const raw = buf.toString('utf-8');
  // Parse sekedar untuk validasi dan hitung baris.
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = parsed.data.length;
  return { kind: 'csv', text: `# CSV (${rows} baris)\n\n${raw}` };
}

// ─── PPTX / ODT / ODP / RTF via officeparser ──────────────────────────────

export async function extractOfficeText(buf: Buffer): Promise<OfficeExtract> {
  // Dynamic import: officeparser versi beda-beda API-nya.
  const mod = (await import('officeparser')) as unknown as {
    parseOfficeAsync?: (b: Buffer) => Promise<string>;
    parseOffice?: (b: Buffer) => Promise<string> | string;
    default?: (b: Buffer) => Promise<string> | string;
  };
  const fn = mod.parseOfficeAsync ?? mod.parseOffice ?? mod.default;
  if (!fn) throw new Error('officeparser API not found');
  const result = await fn(buf);
  const text = typeof result === 'string' ? result : String(result);
  return { kind: 'office', text };
}