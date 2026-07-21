![Wolbarg — Memory Infrastructure for AI Agents](./assets/wolbarg-banner.png)

# Wolbarg

**Modular, provider-agnostic semantic memory for AI agents.**

[![npm version](https://img.shields.io/npm/v/wolbarg.svg)](https://www.npmjs.com/package/wolbarg)
[![SDK CI](https://github.com/wolbarg/wolbarg/actions/workflows/sdk-ci.yml/badge.svg?branch=main)](https://github.com/wolbarg/wolbarg/actions/workflows/sdk-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-wolbarg.com-black)](https://wolbarg.com)
[![Benchmarks](https://img.shields.io/badge/benchmarks-v0.4%20stress-black)](https://wolbarg.com/benchmarks)

```bash
npm install wolbarg
```

Wolbarg is **memory infrastructure**, not an agent framework. Agents call `remember()` / `recall()` (and optionally ingest, compress, subscribe, and link memories in a graph). You bring SQLite or PostgreSQL, any OpenAI-compatible embedding API, and optional peers for PDF/DOCX/OCR/Neo4j.

**Current release: [v0.5.4](./CHANGELOG.md)** — official framework adapters (`@wolbarg/openai`, `@wolbarg/langchain`, `@wolbarg/llamaindex`, `@wolbarg/mastra`, `@wolbarg/vercel-ai`). Still includes experimental `rememberFromMessages()`, 0.5 graph memory (SQLite + Neo4j), `includeGraph` recall, and [Wolbarg Studio](https://wolbarg.com/docs/observability).

---

## Why Wolbarg?

| Problem | What Wolbarg does |
| --- | --- |
| Agents forget between sessions | Durable semantic memory on **your** disk or Postgres |
| Vendor lock-in | Pluggable embeddings, LLM, rerankers, OCR, vision, storage, graph |
| Vectors alone are not enough | Hybrid search (semantic + BM25), metadata filters, MMR, optional rerank |
| Multi-agent writes collide | SQLite `BEGIN IMMEDIATE` + retries; Postgres row-level locking |
| Duplicate facts pile up | Opt-in write-time dedupe / upsert |
| Repeated embeds cost money | Transparent embedding cache (default on) |
| Need structure, not only similarity | Optional **graph** — `linkMemories` / `getRelated` (SQLite ↔ Neo4j) |
| Hard to debug memory | Telemetry + **Wolbarg Studio** (local, read-only) |

---

## Features

- **Storage** — SQLite (`node:sqlite` + sqlite-vec) or PostgreSQL (+ optional pgvector)
- **Recall** — semantic, hybrid, metadata filters, MMR, rerank, `explain: true`
- **Ingest** — text / markdown / PDF / DOCX / images (peers for PDF/DOCX/OCR)
- **Compress** — optional LLM summarization with archive lineage
- **`subscribe()`** — real-time change events (SQLite in-process; Postgres LISTEN/NOTIFY)
- **Concurrency** — multi-writer SQLite hardening (`WOLBARG_STORAGE_LOCKED`)
- **Embedding cache** — `hash(content) + model`
- **Dedupe / upsert** — opt-in exact / near / exact-or-near
- **Graph memory (0.5)** — `sqliteGraph` / `neo4jGraph`, `linkMemories`, `getRelated`, `includeGraph`
- **Conversation bridge (0.5.2, experimental)** — `rememberFromMessages()` raw or LLM extract
- **Framework adapter** — official [`@wolbarg/vercel-ai`](../packages/vercel-ai/) middleware (`wrapLanguageModel`)
- **Checkpoints / export** — file-backed SQLite snapshots (+ graph file when applicable)
- **Telemetry** — independent event DB; Studio dashboard, Trace Explorer, graph canvas

Docs: [Getting started](https://wolbarg.com/docs/getting-started) · [Vercel AI](https://wolbarg.com/docs/integrations/vercel-ai) · [rememberFromMessages](https://wolbarg.com/docs/api/remember-from-messages) · [Graph memory](https://wolbarg.com/docs/graph-memory) · [Studio](https://wolbarg.com/docs/observability)

---

## Benchmarks (v0.4.0 stress · mock embeddings)

Published dual-backend **v4-stress** suite (2026-07-18 · Node v24.13.1 · win32/arm64 · 8 CPUs). Mock embeddings isolate SDK + database cost — not LIVE provider latency.

### Headlines

| Metric | SQLite | PostgreSQL |
| --- | --- | --- |
| Cold `ready()` | **16.18 ms** | **91.39 ms** |
| Batch remember (200) | **5,795 ops/s** | **2,795 ops/s** |
| Bulk insert 2k | **7,509 ops/s** | **4,085 ops/s** |
| Recall p95 @ 2k | **4.83 ms** | **141.5 ms** |
| 16 writers throughput | **8,660 ops/s** | **3,335 ops/s** |
| Embedding cache speedup | **1.47×** | **1.18×** |
| Suite result | 25 pass / 0 fail | 21 pass / 0 fail / 4 skip\* |

\*Postgres skips SQLite-only paths (telemetry EventDatabase, file checkpoints, export/import).

### SQLite — stress & concurrency

| Case | Result |
| --- | --- |
| Bulk insert 2k + search | 7,509 insert ops/s · recall p50 **4.12 ms** · p95 **4.83 ms** |
| 8 writers × 20 ops | **6,084** ops/s · p95 **3.05 ms** · 0 failures |
| 16 writers × 20 ops | **8,660** ops/s · p95 **2.46 ms** · 0 failures |
| 32 writers × 20 ops | **6,798** ops/s · p95 **22.94 ms** · 0 failures |
| Mixed read/write storm | 0 failures |

### PostgreSQL — stress & concurrency

| Case | Result |
| --- | --- |
| Bulk insert 2k + search | 4,085 insert ops/s · recall p50 **23.29 ms** · p95 **141.5 ms** |
| 8 writers × 20 ops | **2,555** ops/s · p95 **8.51 ms** · 0 failures |
| 16 writers × 20 ops | **3,335** ops/s · p95 **9.48 ms** · 0 failures |
| 32 writers × 20 ops | **3,802** ops/s · p95 **14.77 ms** · 0 failures |
| Mixed read/write storm | 0 failures |

**Artifacts:** [SQLite JSON](https://wolbarg.com/benchmarks/version-0.4.0-sqlite-benchmark.json) · [SQLite MD](https://wolbarg.com/benchmarks/version-0.4.0-sqlite-benchmark.md) · [Postgres JSON](https://wolbarg.com/benchmarks/version-0.4.0-postgres-benchmark.json) · [Postgres MD](https://wolbarg.com/benchmarks/version-0.4.0-postgres-benchmark.md) · [Interactive page](https://wolbarg.com/benchmarks) · [Methodology](https://wolbarg.com/docs/benchmarks)

Also published: [embedding-cache](https://wolbarg.com/benchmarks/embedding-cache.json) · [multiprocess concurrency](https://wolbarg.com/benchmarks/multiprocess-concurrency.json)

---

## Installation

```bash
npm install wolbarg
# or: pnpm add wolbarg · yarn add wolbarg · bun add wolbarg
```

**Requires Node.js 22.5+** (built-in `node:sqlite`).

### Optional peers

Install only what you use:

| Peer | Required for |
| --- | --- |
| `pg` | PostgreSQL storage |
| `neo4j-driver` | `neo4jGraph(...)` |
| `pdf-parse@1.1.4` | PDF ingest |
| `mammoth` | DOCX ingest |
| `tesseract.js` | OCR |

```bash
npm install pg neo4j-driver          # production storage + graph
npm install pdf-parse@1.1.4 mammoth  # document ingest
```

Peers are **not** bundled. Missing peers fail at use time for that path — not at import. Plain `.txt` / `.md` / `.csv` / `.json` and SQLite graph need no extras.

---

## Quick start

```ts
import { wolbarg, openaiEmbedding, openaiLlm, bm25 } from "wolbarg";

const ctx = wolbarg({
  organization: "my-org",
  database: { provider: "sqlite", url: "./memory.db" },
  embedding: openaiEmbedding({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "text-embedding-3-small",
  }),
  llm: openaiLlm({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4.1-mini",
  }),
  keywordSearch: bm25(),
  concurrency: { maxRetries: 5 },
  embeddingCache: { enabled: true },
  memory: { dedupe: { enabled: true, strategy: "exact-or-near" } },
  telemetry: {
    enabled: true,
    database: { provider: "sqlite", url: "./telemetry.db" },
    level: "debug",
  },
});

await ctx.ready();

const saved = await ctx.remember({
  agent: "research",
  content: { text: "Stripe supports recurring invoices." },
  metadata: { topic: "billing" },
});
// saved.action === "created" | "updated"

const hits = await ctx.recall({
  query: "How do recurring invoices work?",
  topK: 5,
  hybrid: true,
});

ctx.subscribe({ organization: "my-org" }, (e) => {
  console.log(e.event, e.memoryId);
});

await ctx.checkpoint("before-compress");
await ctx.close();
```

### Graph memory (0.5)

Same typed API locally and in production — swap only the factory:

```ts
import { wolbarg, openaiEmbedding, sqliteGraph, neo4jGraph } from "wolbarg";

// Local
graph: sqliteGraph({ path: "./graph.db" })

// Production
graph: neo4jGraph({
  url: process.env.NEO4J_URL!,
  username: process.env.NEO4J_USER!,
  password: process.env.NEO4J_PASSWORD!,
})
```

```ts
const a = await ctx.remember({
  agent: "support",
  content: { text: "Refunds take 5 business days." },
});
const b = await ctx.remember({
  agent: "support",
  content: { text: "Chargebacks escalate to risk." },
});

await ctx.linkMemories(a.id, b.id, "related_to");
const related = await ctx.getRelated(a.id, { depth: 1 });

const withGraph = await ctx.recall({
  query: "refunds",
  includeGraph: true,
});
// withGraph[0].related — neighbors from the graph
```

Guide: [Graph memory](https://wolbarg.com/docs/graph-memory) · Prefer a [provider-isolated project layout](https://wolbarg.com/docs/installation#project-layout) so backend swaps stay one-file.

### Constructor DI (still supported)

```ts
import { Wolbarg, sqlite, openaiEmbedding } from "wolbarg";

const ctx = new Wolbarg({
  organization: "my-org",
  storage: sqlite("./memory.db"),
  embedding: openaiEmbedding({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "text-embedding-3-small",
  }),
});
```

**Required:** `organization`, `storage` or `database`, `embedding`.  
**Optional:** `llm`, `keywordSearch`, `reranker`, `ocr`, `vision`, `chunking`, `telemetry`, `concurrency`, `embeddingCache`, `memory.dedupe`, `graph`, `checkpoint` / `checkpointDirectory`.

---

## API surface

| Method | Role |
| --- | --- |
| `remember` / `rememberBatch` | Embed + store (`RememberResult` includes `action`) |
| `update` | Edit an existing memory by id |
| `recall` / `recallBatch` | Semantic / hybrid search; `explain` · `includeGraph` |
| `ingest` | Documents → chunks → memories |
| `compress` | LLM summary (requires `llm`) |
| `linkMemories` / `getRelated` | Graph edges / traversal (requires `graph`) |
| `subscribe` | Real-time change callbacks |
| `checkpoint` / `rollback` / `listCheckpoints` / … | SQLite snapshots (+ graph file when SQLite graph) |
| `export` / `import` | Portable SQLite + manifest |
| `forget` / `history` / `stats` / `clear` | Lifecycle (forget/clear cascade graph when configured) |
| `ready` / `close` / `flushTelemetry` | Lifecycle |

Full reference: [wolbarg.com/docs/api](https://wolbarg.com/docs/api)

---

## Wolbarg Studio

Local observability dashboard — **not** bundled in the npm package. The SDK writes telemetry; Studio reads it (and can open memory / graph files for the canvas).

```bash
git clone https://github.com/Atharvmunde11/wolbarg-studio
cd wolbarg-studio
npm install
npm run dev   # http://localhost:3100
```

Connect telemetry (`./telemetry.db`), optional memory DB, checkpoint directory, and graph backend. Screenshots and setup: [Observability & Studio](https://wolbarg.com/docs/observability).

---

## Documentation

| Topic | Link |
| --- | --- |
| Getting started | https://wolbarg.com/docs/getting-started |
| Installation & project layout | https://wolbarg.com/docs/installation |
| Configuration | https://wolbarg.com/docs/configuration |
| Graph memory | https://wolbarg.com/docs/graph-memory |
| Observability & Studio | https://wolbarg.com/docs/observability |
| Concurrency | https://wolbarg.com/docs/concurrency |
| Real-time events | https://wolbarg.com/docs/realtime-events |
| Embedding cache | https://wolbarg.com/docs/embedding-cache |
| Memory upsert | https://wolbarg.com/docs/memory-upsert |
| What's new in 0.5 | https://wolbarg.com/docs/guides/whats-new |
| Migration | https://wolbarg.com/docs/migration |
| Limitations | https://wolbarg.com/docs/guides/limitations |
| Changelog | [CHANGELOG.md](./CHANGELOG.md) |

---

## Limitations

- **Node 22.5+** required (`node:sqlite`).
- **Ingest peers** required for PDF / DOCX / OCR paths.
- **PDF** text-layer via `pdf-parse`; scan PDFs need OCR/vision.
- **Telemetry** is SQLite-only today (Postgres typed but not implemented).
- **SQLite `subscribe()`** is in-process only; Postgres uses LISTEN/NOTIFY.
- **Checkpoints / export** require file-backed SQLite memory (not `:memory:` / not Postgres).
- **Neo4j** checkpoint / export / import throw `GraphCheckpointNotSupportedError` (refuse, don't skip).
- **Cypher `query()`** is Neo4j-only; SQLite graph uses typed methods.
- Not an agent framework, chat UI, or hosted vector SaaS.

---

## Upgrade

```bash
npm install wolbarg@^0.5.0
```

0.5 is **additive**. Omitting `graph` keeps 0.4 behavior. See [Migration](https://wolbarg.com/docs/migration) and [CHANGELOG](./CHANGELOG.md).

---

## License

MIT © [Atharv Munde](https://github.com/Atharvmunde11)
