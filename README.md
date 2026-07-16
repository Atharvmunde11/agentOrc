<p align="center">
  <img src="./assets/wolbarg-banner.png" alt="Wolbarg Logo: Memory Infrastructure for AI Agents" width="720" />
</p>

# Wolbarg

**Modular, provider-agnostic semantic memory for AI agents (v0.3.0).**

[![npm version](https://img.shields.io/npm/v/wolbarg.svg)](https://www.npmjs.com/package/wolbarg)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-wolbarg.com-black)](https://wolbarg.com)
[![Benchmarks](https://img.shields.io/badge/benchmarks-Storage%20suite-black)](https://wolbarg.com/benchmarks)

## Benchmarks

**v0.2.1 Storage suite** (mock embeddings · scale quick) — dual-backend SQLite + PostgreSQL:

| Metric | Result |
| --- | --- |
| SQLite search @ 1k | **2.02 ms** |
| SQLite insert @ 1k | **1.72k ops/sec** |
| SQLite cold start | **7.91 ms** |
| Postgres 16 writers | **1.12k ops/sec** |

Storage (mock) ≠ LIVE (real providers). Full page: [wolbarg.com/benchmarks](https://wolbarg.com/benchmarks) · [methodology](https://wolbarg.com/docs/benchmarks) · [raw JSON](https://wolbarg.com/benchmarks/benchmark.json).

## Installation

```bash
npm install wolbarg
```

Node.js **22.5+**.

### Optional peers (install when you use the feature)

| Peer | Required for |
| --- | --- |
| `pg` | `postgres({ … })` storage |
| `pdf-parse` (pin `@1.1.4`) | `ingest()` of `.pdf` files |
| `mammoth` | `ingest()` of `.docx` files |
| `tesseract.js` | OCR provider for images |

```bash
# Example: PDF + DOCX ingest
npm install pdf-parse@1.1.4 mammoth
```

**Important:** these packages are **not** bundled with `Wolbarg`. If you call `ingest()` on PDF/DOCX without the matching peer, Wolbarg throws a configuration error at use time (not at import). Plain `.txt` / `.md` / `.csv` / `.json` need no extras.

## Quick start

```ts
import {
  Wolbarg,
  sqlite,
  openaiEmbedding,
  openaiLlm,
  bm25,
  meta,
} from "wolbarg";

const ctx = new Wolbarg({
  organization: "my-org",
  storage: sqlite("./memory.db"),
  embedding: openaiEmbedding({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "text-embedding-3-small",
  }),
  llm: openaiLlm({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4.1-mini",
  }),
  keywordSearch: bm25(),
});

await ctx.remember({
  agent: "research",
  content: { text: "Stripe supports recurring invoices." },
  metadata: { topic: "billing" },
});

const hits = await ctx.recall({
  query: "recurring invoices",
  topK: 5,
  hybrid: true,
  filter: { metadata: meta.eq("topic", "billing") },
});
```

**Required:** `organization`, `storage`, `embedding`.  
**Optional:** `llm`, `keywordSearch`, `reranker`, `ocr`, `vision`, `chunking`, `compression`, `retrieval`.

Calling `compress` without `llm` is a TypeScript error.

## API

| Method | Description |
| --- | --- |
| `remember` | Store + embed |
| `recall` | Semantic / hybrid search |
| `ingest` | Documents → chunks → memories (**peers** for PDF/DOCX/OCR) |
| `compress` | LLM summary (needs `llm`) |
| `forget` / `history` / `stats` / `clear` | Management |
| `ready` / `close` | Lifecycle |

Full documentation: [wolbarg.com](https://wolbarg.com/docs/introduction)

## Limitations (v0.2)

- **Ingest peers are opt-in but required for those formats** — see table above.
- **PDF text layer only** via `pdf-parse`; scan/image PDFs need OCR/vision (or a text PDF). Older pdf.js in `pdf-parse@1.1.4` may reject some modern PDFs.
- **Node `node:sqlite` is experimental**; Node **22.5+** required.
- **Postgres** needs `pg`; `pgvector` is optional (falls back to byte embeddings + in-process distance).
- **Not** an agent framework, chat UI, or hosted vector SaaS.

See [Limitations (v0.2)](https://wolbarg.com/docs/guides/limitations) for the full list.

## Migration from 0.1

`init()` still works. Prefer constructor DI. LLM is optional. Schema auto-migrates to v2.

## License

MIT
