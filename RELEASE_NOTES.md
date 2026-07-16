# Wolbarg 0.2.1

**Production hardening for SQLite and PostgreSQL.** Same API as 0.2.0 — safer transactions, correct FTS and multi-tenant isolation, and faster filtered recall.

```bash
npm install wolbarg@0.2.1
```

Numbers: [wolbarg.com/benchmarks](https://wolbarg.com/benchmarks)

---

## SQLite

WAL-safe pragmas, prepared statements, and crash-safe batch inserts. FTS5 updates run in the same ACID transaction as semantic writes, so hybrid search stays consistent after partial failures. Blob vector-index init and overfetch paths are fixed for correct recall.

## PostgreSQL

Named prepared statements, concurrent insert coalescing / `unnest` batches, and `COPY` for large ingest. Org-scoped ANN with adaptive overfetch. HNSW is built lazily before the first KNN — bulk inserts stay fast until you need approximate search.

## Performance

Batched SQLite transactions, coalesced Postgres inserts, and adaptive overfetch on filtered ANN cut storage-path latency without changing the public API. Benchmarks separate mock (SDK + DB) stress from LIVE embedding-provider spots — see the methodology on the [benchmarks page](https://wolbarg.com/benchmarks).

## Correctness

### FTS

Archived memories are removed from FTS so hybrid / keyword search never returns archived rows. When FTS diverges from the primary store, a rebuild path restores alignment.

### Multi-tenant isolation

Organization filters are enforced on ANN / HNSW query paths. Tenants cannot leak across shared Postgres instances.

### HNSW lifecycle

Indexes are created lazily before the first KNN. Soft org reset no longer drops unrelated indexes.

### Compression

Active-set reduction and archive bookkeeping stay aligned with recall filters, so compressed history does not reappear incorrectly in search.

---

## Requirements

- Node.js **22.5+**
- SQLite (built-in) or PostgreSQL with optional pgvector

## Upgrade

Drop-in for 0.2.0. No schema migration beyond what 0.2.0 already shipped.

```bash
npm install wolbarg@0.2.1
```

Full changelog: [CHANGELOG.md](./CHANGELOG.md)
