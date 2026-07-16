# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-07-16

### Changed

- **Rebrand** — product renamed from AgentOrc / `agentorc` to **Wolbarg** / `wolbarg`
- **API** — `AgentOrc` → `Wolbarg`, `AgentOrcOptions` → `WolbargOptions`, `AgentOrcError` → `WolbargError`
- **Links** — docs and homepage now at [wolbarg.com](https://wolbarg.com); GitHub at [Atharvmunde11/wolbarg](https://github.com/Atharvmunde11/wolbarg)
- **Schema** — internal meta table renamed `agentorc_meta` → `wolbarg_meta` (new databases only; recreate or migrate existing DBs)

### Migration

```bash
npm uninstall agentorc
npm install wolbarg
```

```ts
import { Wolbarg, sqlite, openaiEmbedding } from "wolbarg";
const ctx = new Wolbarg({ /* same options shape */ });
```

## [0.2.1] — 2026-07-15

### Fixed

- **SQLite production hardening** — WAL-safe pragmas, prepared statements, crash-safe batch inserts, and FTS5 kept in the same ACID transaction as semantic writes
- **PostgreSQL production hardening** — named prepared statements, concurrent insert coalescing / unnest batches, COPY for large ingest, org-scoped ANN with adaptive overfetch, deferred HNSW build
- **FTS correctness** — archived memories removed from FTS so hybrid/keyword search never returns archived rows; rebuild path when FTS diverges
- **Multi-tenant isolation** — organization filters enforced on ANN / HNSW query paths so tenants cannot leak across shared Postgres instances
- **HNSW lifecycle** — index created lazily before first KNN (keeps bulk inserts fast); soft org reset does not drop unrelated indexes incorrectly
- **Compression correctness** — active-set reduction and archive bookkeeping aligned with recall filters
- **Vector index paths** — SQLite blob vector index initialization and overfetch handling fixed for recall correctness

### Improved

- **Performance** — batched transactions (SQLite), insert coalescing (Postgres), adaptive overfetch for filtered ANN
- **Benchmark suite** — dual-backend mock stress + separate LIVE spot suite; clearer methodology separating storage latency from embedding-provider latency
- **Docs / website** — v0.2.1 release notes, dual-backend benchmark page with SQLite and PostgreSQL sections

### Notes

- Storage benchmarks use mock embeddings to isolate SDK + database performance
- LIVE spot benchmarks use real embedding providers for end-to-end latency — these are separate suites; do not mix the numbers
- Node.js **22.5+** still required

## [0.2.0] — 2026-07-14

### Added

- Constructor dependency injection with factory helpers (`sqlite`, `postgres`, `openaiEmbedding`, `openaiLlm`, `bm25`, …)
- PostgreSQL storage provider (`pg` peer) with optional pgvector
- Document `ingest()` for TXT/MD/CSV/JSON, PDF (`pdf-parse`), DOCX (`mammoth`), and images (OCR/vision)
- Hybrid recall (semantic + BM25), metadata filters (`meta.*`), MMR, pluggable rerankers
- Pluggable chunking strategies and optional vision / OCR providers
- Website docs for v0.2 including Limitations and What’s New
- Dual-backend (SQLite + Postgres) test harness

### Changed

- LLM / `compress()` is optional (typed `Wolbarg<true>` when configured)
- Schema migrates to v2; storage moved behind `StorageProvider`
- Prefer constructor DI; `init()` remains as a compatibility shim

### Fixed

- Clearer configuration errors when optional ingest peers are missing
- PDF parser compatibility with `pdf-parse` v1 function API and v2 `PDFParse` class

### Notes / limitations

- PDF/DOCX/OCR require optional peers installed in the consumer app (not bundled)
- Scan/image-only PDFs need OCR/vision or a text-layer PDF
- Node `node:sqlite` is experimental; Node.js **22.5+** required

## [0.1.1] — previous

- Initial npm release path (pre–modular storage / ingest)

[0.2.1]: https://github.com/Atharvmunde11/wolbarg/releases/tag/v0.2.1
[0.2.0]: https://github.com/Atharvmunde11/wolbarg/releases/tag/v0.2.0
[0.1.1]: https://www.npmjs.com/package/wolbarg/v/0.1.1
