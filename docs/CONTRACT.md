# Kontrak Generative UI — Backend ↔ Frontend

Dokumen ini adalah kontrak antara backend GenUI Chat dan harness frontend. Isi hanya fakta kontrak: bentuk data, urutan event, dan perilaku error. Contoh stream diambil apa adanya dari rekaman `scripts/recordSse.ts`.

## 1. Endpoint streaming

`POST /api/sessions/:id/messages`

Body: `{ "text": string, "attachmentIds"?: string[] }`

Header respons:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Server mengirim komentar SSE `: ping` setiap ~15 detik agar koneksi tidak diputus proxy. Klien harus mengabaikan baris yang diawali `:`.

## 2. Block schema

Satu pesan assistant berisi array `Block`. Urutan array = urutan tampil. Setiap blok adalah salah satu dari diskriminan `type` di bawah.

```ts
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
    .array(z.object({ key: z.string(), label: z.string().optional() }))
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
    .array(z.object({ label: z.string(), prompt: z.string() }))
    .max(4)
    .optional(),
});

export const ChoicesBlock = z.object({
  type: z.literal("choices"),
  question: z.string(),
  multi: z.boolean().default(false),
  options: z
    .array(z.object({ label: z.string(), value: z.string().optional() }))
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
```

Field opsional (`filename`, `title`, `note`, `alt`, `align`, `actions`) bisa tidak muncul. Field dengan `.default()` di schema (`language` pada `code`, `version` pada `file`, `tone` pada `card`, `multi` pada `choices`) **selalu** dikirim backend dengan nilai terisi, jadi klien tidak perlu menerapkan default sendiri.

## 3. Event SSE

Setiap event berformat:

```
event: <nama>
data: <JSON>

```

Dua newline mengakhiri event. Nama event dan bentuk `data`:

### 3.1 `message.start`

```json
{ "messageId": string, "sessionId": string }
```

Selalu event pertama setelah respons 200. `messageId` dipakai untuk `message.end` dan korelasi.

### 3.2 `block.start`

```json
{ "index": number, "block": Block }
```

Memulai blok ke-`index`. Untuk `text` dan `code`, `block` adalah block valid dengan `markdown`/`content` berisi string kosong (`""`), siap menerima delta. Untuk semua tipe lain (file, image, table, chart, card, choices), `block` sudah utuh — lihat §5 (block atomik).

### 3.3 `block.delta`

```json
{ "index": number, "delta": string }
```

Hanya dikirim untuk `text` dan `code`. `delta` adalah potongan string yang ditambahkan ke `markdown`/`content` blok ke-`index`. Klien wajib meng-append, bukan replace.

### 3.4 `block.end`

```json
{ "index": number, "block": Block }
```

Blok ke-`index` selesai. `block` adalah versi final yang sudah tervalidasi zod. Klien dianjurkan memakai `block` dari event ini sebagai sumber kebenaran akhir.

### 3.5 `tool.start`

```json
{ "callId": string, "name": string }
```

Model akan memanggil tool `name`. Dikirim sebelum `block.start` blok yang dihasilkan tool tersebut (jika ada). `callId` dipakai untuk mencocokkan `tool.end`.

### 3.6 `tool.end`

```json
{ "callId": string, "ok": boolean, "summary": string }
```

Tool selesai. `summary` adalah ringkasan singkat (bisa berupa pesan error jika `ok: false`). Blok yang dihasilkan tool dikirim **setelah** `tool.end` untuk atomik, **sebelum** `tool.end` untuk streaming — tapi karena semua tool menghasilkan blok atomik, urutan yang berlaku adalah `tool.start` → `block.start` → `block.end` → `tool.end`.

### 3.7 `title`

```json
{ "sessionId": string, "title": string }
```

Dikirim sekali di giliran pertama (saat judul sesi dibuat otomatis). Bisa muncul kapan saja sebelum `message.end`. Klien dianjurkan men-update header sesi tanpa menunggu `message.end`.

### 3.8 `message.end`

```json
{ "messageId": string, "status": "done" | "aborted" | "error", "usage": Usage | null }
```

Event penutup. `status`:

- `done` — giliran selesai normal.
- `aborted` — klien memutus koneksi di tengah stream; backend membatalkan permintaan ke model dan menyimpan status.
- `error` — error terjadi setelah streaming dimulai (mis. timeout upstream). Detail error dikirim lewat event `error` sebelum `message.end`.

`usage` adalah objek `{ prompt_tokens?, completion_tokens?, total_tokens? }` dari upstream, atau `null` bila tidak tersedia.

### 3.9 `error`

```json
{ "code": string, "message": string }
```

Dikirim sebelum `message.end` bila ada error setelah streaming dimulai. `code` yang umum: `STREAM_ERROR` (error dari upstream), atau `code` dari `AppError` (`BAD_REQUEST`, `NOT_FOUND`, dll.) bila error terjadi di server.

## 4. Urutan `index`

`index` monoton naik di dalam satu turn, dimulai dari `0`. Urutan `index` = urutan tampil di UI. Tidak ada gap.

Satu-satunya event di luar urutan ini adalah `message.start`, `title`, `message.end`, `error`, dan `tool.start`/`tool.end` — semuanya bukan blok dan tidak memiliki `index`.

## 5. Block atomik

Block tipe `file`, `image`, `table`, `chart`, `card`, `choices` dikirim **atomik**:

```
block.start  → block.end   (tanpa block.delta di antaranya)
```

Isi `block` di kedua event **identik**. Klien boleh menampilkan blok setelah `block.end` dan mengabaikan `block.start` untuk tipe ini, atau langsung menampilkan di `block.start`. Disarankan: render di `block.start` agar tampil secepat mungkin, lalu verifikasi ulang di `block.end` (kalau ada perbedaan, `block.end` menang).

`choices` mengakhiri giliran: setelah `block.end` `choices`, model tidak menerima respons lagi di giliran itu. Klik user pada opsi menjadi pesan user berikutnya (`POST messages` baru).

## 6. Error dan abort

### 6.1 Abort oleh klien

Klien memutus koneksi (`res.close` / `req.close` di server). Backend:

- Membatalkan fetch upstream via `AbortController`.
- Menyimpan pesan assistant yang sudah diemisi dengan `status: "aborted"` di database.
- Tidak mengirim `message.end` (koneksi sudah tertutup).

Klien tidak akan menerima `message.end` untuk abort. Bila UI butuh tahu status, klien harus query `GET /api/sessions/:id` setelah reconnect.

### 6.2 Error upstream sebelum token pertama

Retry otomatis (2x dengan exponential backoff) di sisi backend. Klien tidak melihat error ini.

### 6.3 Error upstream setelah streaming mulai

Backend mengirim `error` lalu `message.end` dengan `status: "error"`. Blok yang sudah diemisi tetap disimpan.

### 6.4 Batas iterasi agent

Bila loop agent mencapai `MAX_TOOL_ITERATIONS` (default 8) tanpa selesai natural, backend menambahkan satu text block penutup jujur (mis. "_Aku mencapai batas langkah, ini hasil sejauh ini._") sebelum `message.end` dengan `status: "done"`.

### 6.5 Safety gate

Bila input user ditolak oleh content safety (opsional, `SAFETY_ENABLED=true`), backend mengirim satu text block penolakan, lalu `message.end` dengan `status: "done"`. Model utama tidak dipanggil. Tidak ada blok lain di giliran itu.

## 7. Reload sesi

`GET /api/sessions/:id` mengembalikan `messages[]` dengan `blocks[]` yang sama persis dengan blok yang diemisi saat streaming. Reload tampil identik dengan saat streaming berlangsung.

Pesan dengan `status: "aborted"` atau `"error"` tetap ditampilkan; klien bisa menampilkan indikator sesuai `status`.

## 8. Contoh stream nyata

Berikut adalah rekaman SSE apa adanya dari `scripts/recordSse.ts` terhadap backend lokal. Format: blok kode di bawah memuat byte yang dikirim server, tanpa diedit.

### 8.1 Teks + kode (`docs/samples/text-code.sse`)

Prompt: _"Tulis fungsi TypeScript sederhana bernama add(a: number, b: number) yang mengembalikan penjumlahan, lalu jelaskan singkat apa fungsinya."_

Alur: `message.start` → `block.start code` → beberapa `block.delta` → `block.end code` → `block.start text` → beberapa `block.delta` → `block.end text` → `message.end` (`status: "done"`).

```
event: message.start
data: {"messageId":"6af5d0214636510c41dff405","sessionId":"6af5d0214636510c41dff403"}

event: block.start
data: {"index":0,"block":{"type":"code","language":"ts","content":""}}

event: block.delta
data: {"index":0,"delta":"function add(a: number"}

event: block.delta
data: {"index":0,"delta":", b: number): number"}

event: block.delta
data: {"index":0,"delta":" {\n  return a + b"}

event: block.delta
data: {"index":0,"delta":";\n}"}

event: block.end
data: {"index":0,"block":{"type":"code","language":"ts","content":"function add(a: number, b: number): number {\n  return a + b;\n}"}}

event: block.start
data: {"index":1,"block":{"type":"text","markdown":""}}

event: block.delta
data: {"index":1,"delta":"\n**Pen"}

event: block.delta
data: {"index":1,"delta":"jelasan:**  \nF"}

event: block.delta
data: {"index":1,"delta":"ungsi `add` menerima"}

event: block.delta
data: {"index":1,"delta":" dua parameter bert"}

event: block.delta
data: {"index":1,"delta":"ipe `number` (`a"}

event: block.delta
data: {"index":1,"delta":"` dan `b`), menj"}

event: block.delta
data: {"index":1,"delta":"umlahk"}

event: block.delta
data: {"index":1,"delta":"annya dengan operator `+`,"}

event: block.delta
data: {"index":1,"delta":" lalu mengembalikan hasil"}

event: block.delta
data: {"index":1,"delta":" pen"}

event: block.delta
data: {"index":1,"delta":"jumlahan tersebut"}

event: block.delta
data: {"index":1,"delta":" ("}

event: block.delta
data: {"index":1,"delta":"bert"}

event: block.delta
data: {"index":1,"delta":"ipe `number"}

event: block.delta
data: {"index":1,"delta":"` pula"}

event: block.delta
data: {"index":1,"delta":"). Contoh pem"}

event: block.delta
data: {"index":1,"delta":"aka"}

event: block.delta
data: {"index":1,"delta":"ian: `add(3"}

event: block.delta
data: {"index":1,"delta":", 5)` meng"}

event: block.delta
data: {"index":1,"delta":"embalikan `8"}

event: block.delta
data: {"index":1,"delta":"`."}

event: block.end
data: {"index":1,"block":{"type":"text","markdown":"\n**Penjelasan:**  \nFungsi `add` menerima dua parameter bertipe `number` (`a` dan `b`), menjumlahkannya dengan operator `+`, lalu mengembalikan hasil penjumlahan tersebut (bertipe `number` pula). Contoh pemakaian: `add(3, 5)` mengembalikan `8`."}}

event: message.end
data: {"messageId":"6af5d0214636510c41dff405","status":"done","usage":null}
```

Catatan: blok `code` muncul lebih dulu karena model menulis fence kode sebelum narasi. Urutan blok di UI = urutan emisi, bukan urutan logis "penjelasan dulu lalu kode".

### 8.2 Tool UI: `render_table` (`docs/samples/table.sse`)

Prompt: _"Buatkan tabel perbandingan 3 framework JavaScript populer (React, Vue, Angular) beserta tahun rilis dan bahasa utamanya."_

Alur: `message.start` → `tool.start render_table` → `block.start table` → `block.end table` (atomik) → `tool.end ok` → `block.start text` → `block.delta` → `block.end text` → `message.end` (`status: "done"`). Perhatikan `: ping` di antara `message.start` dan `tool.start` — klien harus mengabaikannya.

```
event: message.start
data: {"messageId":"6af5d0254636510c41dff408","sessionId":"6af5d0214636510c41dff403"}

: ping

event: tool.start
data: {"callId":"call-ea1a77de-0937-416b-940e-a9419e6463fd","name":"render_table"}

event: block.start
data: {"index":0,"block":{"type":"table","title":"Perbandingan 3 Framework JavaScript Populer","columns":[{"key":"framework","label":"Framework","align":"left"},{"key":"tahunRilis","label":"Tahun Rilis","align":"center"},{"key":"bahasaUtama","label":"Bahasa Utama","align":"left"}],"rows":[{"framework":"React","tahunRilis":2013,"bahasaUtama":"JavaScript (JSX) / TypeScript"},{"framework":"Vue","tahunRilis":2014,"bahasaUtama":"JavaScript / TypeScript"},{"framework":"Angular","tahunRilis":2016,"bahasaUtama":"TypeScript"}]}}

event: block.end
data: {"index":0,"block":{"type":"table","title":"Perbandingan 3 Framework JavaScript Populer","columns":[{"key":"framework","label":"Framework","align":"left"},{"key":"tahunRilis","label":"Tahun Rilis","align":"center"},{"key":"bahasaUtama","label":"Bahasa Utama","align":"left"}],"rows":[{"framework":"React","tahunRilis":2013,"bahasaUtama":"JavaScript (JSX) / TypeScript"},{"framework":"Vue","tahunRilis":2014,"bahasaUtama":"JavaScript / TypeScript"},{"framework":"Angular","tahunRilis":2016,"bahasaUtama":"TypeScript"}]}}

event: tool.end
data: {"callId":"call-ea1a77de-0937-416b-940e-a9419e6463fd","ok":true,"summary":"render_table ok"}

event: block.start
data: {"index":1,"block":{"type":"text","markdown":""}}

event: block.delta
data: {"index":1,"delta":"Tabel perbandingan"}

event: block.delta
data: {"index":1,"delta":" ketiga"}

event: block.delta
data: {"index":1,"delta":" framework tersebut"}

event: block.delta
data: {"index":1,"delta":" sudah dit"}

event: block.delta
data: {"index":1,"delta":"ampilkan di atas."}

event: block.end
data: {"index":1,"block":{"type":"text","markdown":"Tabel perbandingan ketiga framework tersebut sudah ditampilkan di atas."}}

event: message.end
data: {"messageId":"6af5d0254636510c41dff408","status":"done","usage":null}
```

### 8.3 Tool file: `create_file` (`docs/samples/file.sse`)

Prompt: _"Buatkan file README.md sederhana untuk project hello-world TypeScript, lalu tampilkan sebagai file."_

Alur: `message.start` → `tool.start create_file` → `block.start file` → `block.end file` (atomik) → `tool.end ok` → `block.start text` → `block.delta` → `block.end text` → `message.end` (`status: "done"`). `preview: "text"` untuk `.md`.

```
event: message.start
data: {"messageId":"6af5d03d4636510c41dff40b","sessionId":"6af5d0214636510c41dff403"}

event: tool.start
data: {"callId":"call-2a3ca4c9-6d4b-4d29-9082-432f920f6efe","name":"create_file"}

event: block.start
data: {"index":0,"block":{"type":"file","fileId":"6af5d0434636510c41dff40c","name":"README.md","mime":"text/markdown","size":768,"version":1,"preview":"text"}}

event: block.end
data: {"index":0,"block":{"type":"file","fileId":"6af5d0434636510c41dff40c","name":"README.md","mime":"text/markdown","size":768,"version":1,"preview":"text"}}

event: tool.end
data: {"callId":"call-2a3ca4c9-6d4b-4d29-9082-432f920f6efe","ok":true,"summary":"create_file ok"}

event: block.start
data: {"index":1,"block":{"type":"text","markdown":""}}

event: block.delta
data: {"index":1,"delta":"File **"}

event: block.delta
data: {"index":1,"delta":"README.md** telah dibuat dan"}

event: block.delta
data: {"index":1,"delta":" ditampilkan di atas. Is"}

event: block.delta
data: {"index":1,"delta":"inya berisi desk"}

event: block.delta
data: {"index":1,"delta":"ripsi proyek,"}

event: block.delta
data: {"index":1,"delta":" prasyarat,"}

event: block.delta
data: {"index":1,"delta":" cara instalasi &"}

event: block.delta
data: {"index":1,"delta":" menjalankan, struktur folder"}

event: block.delta
data: {"index":1,"delta":", script npm"}

event: block.delta
data: {"index":1,"delta":" yang"}

event: block.delta
data: {"index":1,"delta":" tersedia, dan lisensi"}

event: block.delta
data: {"index":1,"delta":" MIT."}

event: block.end
data: {"index":1,"block":{"type":"text","markdown":"File **README.md** telah dibuat dan ditampilkan di atas. Isinya berisi deskripsi proyek, prasyarat, cara instalasi & menjalankan, struktur folder, script npm yang tersedia, dan lisensi MIT."}}

event: message.end
data: {"messageId":"6af5d03d4636510c41dff40b","status":"done","usage":null}
```

## 9. Referensi endpoint lain

Hanya untuk konteks harness; bukan bagian streaming:

- `POST /api/files/presign` → presigned PUT URL, `fileId`
- `POST /api/files/:id/complete` → memicu ingestion, status `processing`
- `GET /api/files/:id` → metadata + `status` (`pending | processing | ready | failed`)
- `GET /api/files/:id/download` → stream file, butuh login
- `GET /api/files/:id/content` → preview teks (≤ 200 KB)
- `GET /api/sessions/:id` → sesi + pesan + `blocks`