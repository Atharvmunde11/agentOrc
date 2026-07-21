/**
 * PostgreSQL storage provider with optional pgvector support.
 * Requires the optional `pg` peer dependency.
 *
 * Performance design:
 * - Per-operation pool queries (no global write lock / shared tx client race)
 * - AsyncLocalStorage for nested transactions
 * - Single-statement CTE inserts (no BEGIN/COMMIT for one memory)
 * - Named prepared statements (parse/plan once per connection)
 * - Concurrent insert coalescing into unnest batches
 * - float4[] vector bind (no text "[f,f,…]" parse tax)
 * - Org/agent/archived denormalized on embeddings for filtered ANN
 * - Large bulk inserts via sequential fat unnest (COPY-class amortization)
 * - JSONB metadata filter pushdown
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseError, InitializationError, ConfigurationError } from "../../errors/index.js";
import { matchesMetadata } from "../../filters/match.js";
import { compileMetadataFilterToPostgres } from "../../filters/sql-compile-postgres.js";
import { SCHEMA_VERSION, META_KEYS } from "../../schema/index.js";
import { WolbargLogger } from "../../telemetry/logger.js";
import {
  deserializeMetadata,
  serializeMetadata,
} from "../../utils/index.js";
import { cosineDistance } from "../../utils/vector.js";
import { hashMemoryContent } from "../../memory/dedupe.js";
import { notifyMemoryChange } from "../../subscribe/postgres-listener.js";
import type { MemoryChangeEvent } from "../../subscribe/types.js";
import type {
  HistoryRow,
  InsertMemoryInput,
  MemoryRow,
  RepositoryFilter,
  StorageProvider,
  UpdateMemoryInput,
  VectorSearchHit,
} from "../types.js";
type PgQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};

type PgQueryable = {
  query: (
    textOrConfig: string | { name?: string; text: string; values?: unknown[] },
    params?: unknown[],
  ) => Promise<PgQueryResult>;
};

type PgPoolClient = PgQueryable & {
  release: () => void;
  query: PgQueryable["query"];
};

type PgPool = PgQueryable & {
  end: () => Promise<void>;
  connect: () => Promise<PgPoolClient>;
  on?: (event: "connect", listener: (client: PgPoolClient) => void) => void;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

export interface PostgresProviderOptions {
  connectionString: string;
  maxPoolSize?: number;
  /**
   * When false, uses `synchronous_commit=off` on every pool connection.
   * Much higher write throughput; recent commits can be lost on OS crash.
   * Default true (full durability).
   */
  durableWrites?: boolean;
}

const txStore = new AsyncLocalStorage<PgPoolClient>();

const warnLogger = new WolbargLogger("warn");
let warnedPgvectorFallback = false;
let warnedFtsKeywordSearch = false;
let warnedHnswSoftFail = false;

/** Statement names for per-connection prepared-statement cache. */
const STMT = {
  insertOne: "Wolbarg_insert_one_v5",
  insertBatch: "Wolbarg_insert_batch_v6",
} as const;

/**
 * Bind embedding as float4[] for `$n::float4[]::vector` (single-row path).
 * Avoids multi-KB text literals and Postgres vector text parse.
 */
function toFloat4Param(embedding: Float32Array): number[] {
  const out = new Array<number>(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    out[i] = embedding[i]!;
  }
  return out;
}

/**
 * pgvector text literal for batch unnest.
 * node-pg cannot reliably bind float4[][] (collapses to float4[] → cast errors).
 */
function toVectorLiteral(embedding: Float32Array): string {
  const n = embedding.length;
  let s = "[";
  for (let i = 0; i < n; i += 1) {
    if (i !== 0) s += ",";
    s += embedding[i];
  }
  return s + "]";
}

/** Append/override a libpq query param (e.g. options=-c synchronous_commit=off). */
function appendConnectionOption(
  connectionString: string,
  key: string,
  value: string,
): string {
  try {
    const url = new URL(connectionString);
    if (key === "options") {
      const existing = url.searchParams.get("options");
      url.searchParams.set(
        "options",
        existing ? `${existing} ${value}`.trim() : value,
      );
    } else {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    const sep = connectionString.includes("?") ? "&" : "?";
    return `${connectionString}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

/** Session GUCs that must be set before the pool hands out a client. */
function withPoolStartupOptions(
  connectionString: string,
  durableWrites: boolean,
): string {
  const flags = [
    "-c jit=off",
    // Bake HNSW search GUCs into the connection — avoids per-recall set_config.
    "-c hnsw.ef_search=40",
    "-c hnsw.iterative_scan=relaxed_order",
  ];
  if (!durableWrites) {
    flags.unshift("-c synchronous_commit=off");
  }
  return appendConnectionOption(connectionString, "options", flags.join(" "));
}

const INSERT_ONE_SQL = `WITH mem AS (
   INSERT INTO memories (
     id, organization, agent, content_text, metadata_json,
     archived, compressed_into, content_hash, created_at, updated_at
   ) VALUES ($1,$2,$3,$4,$5::jsonb,false,NULL,$9,$6,$7)
   RETURNING id, organization, agent, content_text, metadata_json,
             archived::int AS archived, compressed_into, content_hash, created_at, updated_at
 ),
 hist AS (
   INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
   SELECT gen_random_uuid()::text, id, 'created', NULL, $6 FROM mem
 ),
 mapped AS (
   INSERT INTO memory_row_map (memory_id)
   SELECT id FROM mem
   ON CONFLICT (memory_id) DO NOTHING
 ),
 emb AS (
   INSERT INTO memory_embeddings (memory_id, embedding, organization, agent, archived)
   SELECT id, $8::float4[]::vector, $2, $3, false FROM mem
 )
 SELECT * FROM mem`;

/** Batch: RETURNING id only — caller rebuilds MemoryRow from inputs. */
const INSERT_BATCH_SQL = `WITH mem AS (
   INSERT INTO memories (
     id, organization, agent, content_text, metadata_json,
     archived, compressed_into, content_hash, created_at, updated_at
   )
   SELECT id, org, agent, txt, meta::jsonb, false, NULL, h, c, u
   FROM unnest(
     $1::text[], $2::text[], $3::text[], $4::text[],
     $5::text[], $6::timestamptz[], $7::timestamptz[], $8::text[]
   ) AS t(id, org, agent, txt, meta, c, u, h)
   RETURNING id
 ),
 hist AS (
   INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
   SELECT gen_random_uuid()::text, id, 'created', NULL, c
   FROM unnest($1::text[], $6::timestamptz[]) AS t(id, c)
 ),
 mapped AS (
   INSERT INTO memory_row_map (memory_id)
   SELECT unnest($1::text[])
   ON CONFLICT (memory_id) DO NOTHING
 ),
 emb AS (
   INSERT INTO memory_embeddings (memory_id, embedding, organization, agent, archived)
   SELECT id, emb::vector, org, agent, false
   FROM unnest($1::text[], $9::text[], $2::text[], $3::text[]) AS t(id, emb, org, agent)
 )
 SELECT id FROM mem`;

/** Cap per flush so multiple batches pipeline across the pool. */
const COALESCE_FLUSH_MAX = 128;
const COALESCE_FLUSH_THRESHOLD = 48;
const COALESCE_MAX_PARALLEL = 24;
const BULK_CHUNK_NO_HNSW = 500;
const BULK_CHUNK_WITH_HNSW = 250;
const COPY_BATCH_THRESHOLD = 48;

export class PostgresStorageProvider implements StorageProvider {
  readonly name = "postgres";

  private readonly connectionString: string;
  private readonly maxPoolSize: number;
  private readonly durableWrites: boolean;
  private pool: PgPool | null = null;
  private vectorDimensions: number | null = null;
  private hasPgvector = false;
  private hnswIndexEnsured = false;
  private hnswCreateFailures = 0;
  /** Dedup concurrent CREATE INDEX so mixed read/write storms don't pile up. */
  private hnswBuildInFlight: Promise<void> | null = null;
  private hasContentTsv = false;
  /** Coalesce concurrent insertMemory callers into one unnest batch. */
  private insertQueue: Array<{
    input: InsertMemoryInput;
    resolve: (row: MemoryRow) => void;
    reject: (err: unknown) => void;
  }> = [];
  private insertFlushScheduled = false;
  private insertFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private insertFlushInFlight = 0;

  constructor(options: PostgresProviderOptions) {
    this.maxPoolSize = options.maxPoolSize ?? 64;
    this.durableWrites = options.durableWrites !== false;
    // Bake GUCs into the URL — never SET on 'connect' (races with pool checkout).
    this.connectionString = withPoolStartupOptions(
      options.connectionString,
      this.durableWrites,
    );
  }

  getPoolStats(): {
    max: number;
    total: number;
    idle: number;
    waiting: number;
  } {
    const pool = this.pool;
    return {
      max: this.maxPoolSize,
      total: pool?.totalCount ?? 0,
      idle: pool?.idleCount ?? 0,
      waiting: pool?.waitingCount ?? 0,
    };
  }

  /** Dedicated pool accessor for LISTEN/NOTIFY subscribe backend. */
  getPool(): PgPool | null {
    return this.pool;
  }

  async open(): Promise<void> {
    let PoolCtor: new (config: Record<string, unknown>) => PgPool;
    try {
      const mod = await import("pg");
      PoolCtor =
        (mod as { Pool: typeof PoolCtor }).Pool ??
        (mod as { default: { Pool: typeof PoolCtor } }).default.Pool;
    } catch {
      throw new ConfigurationError(
        'PostgreSQL storage requires the optional "pg" package. Install it with: npm install pg',
      );
    }

    try {
      this.pool = new PoolCtor({
        connectionString: this.connectionString,
        max: this.maxPoolSize,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        allowExitOnIdle: true,
        keepAlive: true,
      });
      // Do NOT query on 'connect' — node-pg may check the client out concurrently
      // (overlapping query warning + multi-second stalls under concurrency).
      await this.runMigrations();
      this.hasPgvector = await this.tryEnablePgvector();
      const dims = await this.getEmbeddingDimensions();
      if (dims !== null) {
        this.vectorDimensions = dims;
        const schemaKey = `${this.connectionString}::${dims}`;
        if (!PostgresStorageProvider.vectorSchemaReady.has(schemaKey)) {
          await this.ensureVectorTables(dims);
          PostgresStorageProvider.vectorSchemaReady.add(schemaKey);
        } else {
          this.hasPgvector = true;
          // HNSW may have been dropped by a prior bulk load — check cheaply.
          const idx = await this.query(
            `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memory_embeddings_hnsw' LIMIT 1`,
          ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
          this.hnswIndexEnsured = idx.rows.length > 0;
        }
      }
    } catch (error) {
      await this.pool?.end().catch(() => undefined);
      this.pool = null;
      if (error instanceof ConfigurationError || error instanceof InitializationError) {
        throw error;
      }
      throw new InitializationError(
        `Failed to open PostgreSQL database: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async close(): Promise<void> {
    if (this.insertFlushTimer) {
      clearTimeout(this.insertFlushTimer);
      this.insertFlushTimer = null;
    }
    // Drain coalesced inserts before tearing down the pool.
    const deadline = Date.now() + 5_000;
    while (
      (this.insertQueue.length > 0 || this.insertFlushInFlight > 0) &&
      Date.now() < deadline
    ) {
      if (this.insertQueue.length > 0) {
        await this.flushInsertQueue();
      } else {
        await new Promise<void>((r) => setTimeout(r, 5));
      }
    }
    if (!this.pool) {
      return;
    }
    await this.pool.end();
    this.pool = null;
  }

  /**
   * Run a search query. HNSW GUCs are baked into pool startup options —
   * no per-recall connect()+set_config round-trip.
   */
  private async withSearchSession<T>(
    fn: (client: PgQueryable) => Promise<T>,
  ): Promise<T> {
    return fn(this.requirePool());
  }

  /**
   * Drop HNSW so bulk / concurrent inserts avoid graph maintenance.
   * Next recall rebuilds the index (lazy).
   */
  async dropVectorIndex(): Promise<void> {
    await this.query(`DROP INDEX IF EXISTS idx_memory_embeddings_hnsw`).catch(
      () => undefined,
    );
    this.hnswIndexEnsured = false;
  }

  /** Force HNSW build now (e.g. before timed recall benches). */
  async ensureVectorIndex(): Promise<void> {
    await this.ensureHnswIndex();
  }

  async ensureVectorSchema(dimensions: number): Promise<void> {
    const existing = await this.getEmbeddingDimensions();
    if (existing !== null && existing !== dimensions) {
      throw new InitializationError(
        `Embedding dimensions mismatch: database is configured for ${existing}-d vectors, but the embedding model returned ${dimensions}-d vectors.`,
      );
    }
    this.hasPgvector = await this.tryEnablePgvector();
    await this.ensureVectorTables(dimensions);
    if (existing === null) {
      await this.setEmbeddingDimensions(dimensions);
    }
    this.vectorDimensions = dimensions;
  }

  private async ensureVectorTables(dimensions: number): Promise<void> {
    if (this.hasPgvector) {
      await this.query(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding vector(${dimensions})
        )
      `);
      // Denormalize tenant filters onto embeddings so ANN can pre-filter.
      await this.query(
        `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS organization TEXT`,
      ).catch(() => undefined);
      await this.query(
        `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS agent TEXT`,
      ).catch(() => undefined);
      await this.query(
        `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`,
      ).catch(() => undefined);
      // One-shot denormalization — skip when columns are already populated.
      const needsBackfill = await this.query(
        `SELECT 1 FROM memory_embeddings WHERE organization IS NULL LIMIT 1`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      if (needsBackfill.rows.length > 0) {
        await this.query(`
          UPDATE memory_embeddings e
          SET organization = m.organization,
              agent = m.agent,
              archived = m.archived
          FROM memories m
          WHERE m.id = e.memory_id
            AND e.organization IS NULL
        `).catch(() => undefined);
      }
      await this.query(
        `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_org_active
         ON memory_embeddings (organization)
         WHERE archived = false`,
      ).catch(() => undefined);
      // Do not create HNSW here — defer until first search so bulk inserts stay fast.
      const idx = await this.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memory_embeddings_hnsw' LIMIT 1`,
      );
      this.hnswIndexEnsured = idx.rows.length > 0;
    } else {
      await this.query(`
        CREATE TABLE IF NOT EXISTS memory_embeddings_blob (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding BYTEA NOT NULL
        )
      `);
    }
  }

  /** Cross-process subscribe: NOTIFY after a committed write. */
  async notifyChange(event: MemoryChangeEvent): Promise<void> {
    await notifyMemoryChange(this.requirePool(), event);
  }
  /**
   * Soft reset for a single organization. Drops HNSW only when the embeddings
   * table is empty so other corpora on a shared bench DB stay intact.
   */
  async resetOrganization(organization: string): Promise<void> {
    await this.query(`DELETE FROM memories WHERE organization = $1`, [
      organization,
    ]);
    const count = await this.query(
      `SELECT COUNT(*)::int AS n FROM memory_embeddings`,
    );
    if (Number(count.rows[0]?.n ?? 0) === 0) {
      await this.query(
        `DROP INDEX IF EXISTS idx_memory_embeddings_hnsw`,
      ).catch(() => undefined);
      this.hnswIndexEnsured = false;
    }
  }

  /**
   * Wipe all Wolbarg tables (explicit opt-in). Prefer {@link resetOrganization}.
   */
  async wipeAllData(): Promise<void> {
    await this.query(`TRUNCATE TABLE memories CASCADE`).catch(() => undefined);
    await this.query(
      `DROP INDEX IF EXISTS idx_memory_embeddings_hnsw`,
    ).catch(() => undefined);
    this.hnswIndexEnsured = false;
  }

  /** Build HNSW once before the first KNN query (bulk-friendly inserts). */
  private async ensureHnswIndex(): Promise<void> {
    if (!this.hasPgvector || this.hnswIndexEnsured) {
      return;
    }
    if (this.hnswBuildInFlight) {
      await this.hnswBuildInFlight;
      return;
    }
    this.hnswBuildInFlight = this.buildHnswIndex();
    try {
      await this.hnswBuildInFlight;
    } finally {
      this.hnswBuildInFlight = null;
    }
  }

  private async buildHnswIndex(): Promise<void> {
    if (this.hnswIndexEnsured) {
      return;
    }
    try {
      // CONCURRENTLY avoids blocking writers during mixed read/write storms.
      // IF NOT EXISTS is safe when another backend already finished the build.
      await this.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_embeddings_hnsw
        ON memory_embeddings USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 32)
      `);
      this.hnswIndexEnsured = true;
      this.hnswCreateFailures = 0;
    } catch (error) {
      // Another session may have created it; treat as success when present.
      const idx = await this.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memory_embeddings_hnsw' LIMIT 1`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      if (idx.rows.length > 0) {
        this.hnswIndexEnsured = true;
        this.hnswCreateFailures = 0;
        return;
      }
      this.hnswCreateFailures += 1;
      if (this.hnswCreateFailures === 1 && !warnedHnswSoftFail) {
        warnedHnswSoftFail = true;
        warnLogger.warn(
          "HNSW index creation failed; ANN will fall back to sequential scan.",
        );
      }
      if (this.hnswCreateFailures >= 3) {
        throw new DatabaseError(
          `Failed to create HNSW index after ${this.hnswCreateFailures} attempts: ${this.describe(error)}`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      // Soft-fail: ANN can still run as a sequential scan this round.
    }
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    const result = await this.query(
      `SELECT value FROM Wolbarg_meta WHERE key = $1`,
      [META_KEYS.embeddingDimensions],
    );
    const value = result.rows[0]?.value;
    if (typeof value !== "string") {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async setEmbeddingDimensions(dimensions: number): Promise<void> {
    await this.query(
      `INSERT INTO Wolbarg_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [META_KEYS.embeddingDimensions, String(dimensions)],
    );
    this.vectorDimensions = dimensions;
  }

  async insertMemory(input: InsertMemoryInput): Promise<MemoryRow> {
    this.requireVectorReady();

    // Always coalesce briefly so concurrent remember() calls share one unnest.
    // Do NOT hold a global inFlight mutex — that serializes Postgres like SQLite.
    return new Promise<MemoryRow>((resolve, reject) => {
      this.insertQueue.push({ input, resolve, reject });
      if (this.insertQueue.length >= COALESCE_FLUSH_THRESHOLD) {
        this.clearInsertFlushTimer();
        void this.flushInsertQueue();
        return;
      }
      this.scheduleInsertFlush();
    });
  }

  private clearInsertFlushTimer(): void {
    if (this.insertFlushTimer) {
      clearImmediate(this.insertFlushTimer as unknown as NodeJS.Immediate);
      clearTimeout(this.insertFlushTimer);
      this.insertFlushTimer = null;
    }
    this.insertFlushScheduled = false;
  }

  /** Flush coalesced inserts after a turn so concurrent remember() can join. */
  private scheduleInsertFlush(): void {
    if (this.insertFlushScheduled) {
      return;
    }
    this.insertFlushScheduled = true;
    // setImmediate > queueMicrotask: concurrent awaiters after embed can join.
    this.insertFlushTimer = setImmediate(() => {
      this.insertFlushTimer = null;
      this.insertFlushScheduled = false;
      void this.flushInsertQueue();
    }) as unknown as ReturnType<typeof setTimeout>;
  }

  private async flushInsertQueue(): Promise<void> {
    if (this.insertFlushInFlight >= COALESCE_MAX_PARALLEL) {
      this.scheduleInsertFlush();
      return;
    }
    // Cap flush size so remaining queue can pipeline on other pool connections.
    const batch = this.insertQueue.splice(0, COALESCE_FLUSH_MAX);
    this.clearInsertFlushTimer();
    if (batch.length === 0) {
      return;
    }
    this.insertFlushInFlight += 1;
    // Kick another flush immediately if more work remains (parallel drains).
    if (
      this.insertQueue.length > 0 &&
      this.insertFlushInFlight < COALESCE_MAX_PARALLEL
    ) {
      void this.flushInsertQueue();
    }
    try {
      if (batch.length === 1) {
        const row = await this.insertMemoryImmediate(batch[0]!.input);
        batch[0]!.resolve(row);
        return;
      }
      const rows = await this.insertMemoriesBatch(batch.map((b) => b.input));
      for (let i = 0; i < batch.length; i += 1) {
        batch[i]!.resolve(rows[i]!);
      }
    } catch (error) {
      for (const item of batch) {
        item.reject(error);
      }
    } finally {
      this.insertFlushInFlight -= 1;
      if (this.insertQueue.length > 0) {
        void this.flushInsertQueue();
      }
    }
  }

  /** Single-row insert without coalescing (used by flush + batch of 1). */
  private async insertMemoryImmediate(input: InsertMemoryInput): Promise<MemoryRow> {
    if (this.hasPgvector) {
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : hashMemoryContent(input.contentText);
      const inserted = await this.queryNamed(STMT.insertOne, INSERT_ONE_SQL, [
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        input.createdAt,
        input.updatedAt,
        toFloat4Param(input.embedding),
        contentHash,
      ]);
      return this.mapRow(inserted.rows[0]!);
    }
    return this.insertOneBlob(input);
  }

  async insertMemoriesBatch(inputs: InsertMemoryInput[]): Promise<MemoryRow[]> {
    if (inputs.length === 0) {
      return [];
    }
    this.requireVectorReady();

    if (inputs.length === 1 && this.hasPgvector) {
      return [await this.insertMemoryImmediate(inputs[0]!)];
    }

    if (this.hasPgvector) {
      // Large batches: parallel unnest chunks use the pool as a pipeline.
      if (inputs.length >= COPY_BATCH_THRESHOLD) {
        return this.insertBatchChunked(inputs);
      }
      return this.insertBatchPgvector(inputs);
    }

    return this.withTransaction(async () => {
      const out: MemoryRow[] = [];
      for (const input of inputs) {
        out.push(await this.insertOneBlob(input));
      }
      return out;
    });
  }

  private async insertBatchPgvector(
    inputs: InsertMemoryInput[],
  ): Promise<MemoryRow[]> {
    const ids = new Array<string>(inputs.length);
    const orgs = new Array<string>(inputs.length);
    const agents = new Array<string>(inputs.length);
    const texts = new Array<string>(inputs.length);
    const metas = new Array<string>(inputs.length);
    const created = new Array<string>(inputs.length);
    const updated = new Array<string>(inputs.length);
    const contentHashes = new Array<string | null>(inputs.length);
    const vectors = new Array<string>(inputs.length);

    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i]!;
      ids[i] = input.id;
      orgs[i] = input.organization;
      agents[i] = input.agent;
      texts[i] = input.contentText;
      metas[i] = serializeMetadata(input.metadata);
      created[i] = input.createdAt;
      updated[i] = input.updatedAt;
      contentHashes[i] =
        input.contentHash !== undefined
          ? input.contentHash
          : hashMemoryContent(input.contentText);
      vectors[i] = toVectorLiteral(input.embedding);
    }

    await this.queryNamed(STMT.insertBatch, INSERT_BATCH_SQL, [
      ids,
      orgs,
      agents,
      texts,
      metas,
      created,
      updated,
      contentHashes,
      vectors,
    ]);

    // RETURNING id only — rebuild rows from inputs (avoids shipping JSONB back).
    return inputs.map((_, i) => ({
      id: ids[i]!,
      organization: orgs[i]!,
      agent: agents[i]!,
      content_text: texts[i]!,
      metadata_json: metas[i]!,
      archived: 0,
      compressed_into: null,
      content_hash: contentHashes[i] ?? null,
      created_at: created[i]!,
      updated_at: updated[i]!,
    }));
  }

  /** Parallel unnest when HNSW is absent; sequential when index must stay consistent. */
  private async insertBatchChunked(
    inputs: InsertMemoryInput[],
  ): Promise<MemoryRow[]> {
    const chunkSize = this.hnswIndexEnsured
      ? BULK_CHUNK_WITH_HNSW
      : BULK_CHUNK_NO_HNSW;
    if (inputs.length <= chunkSize) {
      return this.insertBatchPgvector(inputs);
    }
    const chunks: InsertMemoryInput[][] = [];
    for (let i = 0; i < inputs.length; i += chunkSize) {
      chunks.push(inputs.slice(i, i + chunkSize));
    }
    // No HNSW → pipeline chunks across the pool. With HNSW → sequential (lock-friendly).
    if (!this.hnswIndexEnsured) {
      const parts = await Promise.all(
        chunks.map((chunk) => this.insertBatchPgvector(chunk)),
      );
      const out: MemoryRow[] = new Array(inputs.length);
      let offset = 0;
      for (const part of parts) {
        for (let j = 0; j < part.length; j += 1) {
          out[offset + j] = part[j]!;
        }
        offset += part.length;
      }
      return out;
    }
    const out: MemoryRow[] = new Array(inputs.length);
    let offset = 0;
    for (const chunk of chunks) {
      const part = await this.insertBatchPgvector(chunk);
      for (let j = 0; j < part.length; j += 1) {
        out[offset + j] = part[j]!;
      }
      offset += part.length;
    }
    return out;
  }

  private async insertOneBlob(input: InsertMemoryInput): Promise<MemoryRow> {
    return this.withTransaction(async () => {
      const buf = Buffer.from(
        input.embedding.buffer,
        input.embedding.byteOffset,
        input.embedding.byteLength,
      );
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : hashMemoryContent(input.contentText);
      const inserted = await this.query(
        `INSERT INTO memories (
          id, organization, agent, content_text, metadata_json,
          archived, compressed_into, content_hash, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,false,NULL,$8,$6,$7)
        RETURNING id, organization, agent, content_text, metadata_json,
                  archived::int AS archived, compressed_into, content_hash, created_at, updated_at`,
        [
          input.id,
          input.organization,
          input.agent,
          input.contentText,
          serializeMetadata(input.metadata),
          input.createdAt,
          input.updatedAt,
          contentHash,
        ],
      );
      const row = this.mapRow(inserted.rows[0]!);
      await this.query(
        `WITH mapped AS (
           INSERT INTO memory_row_map (memory_id) VALUES ($1)
           ON CONFLICT (memory_id) DO NOTHING
         )
         INSERT INTO memory_embeddings_blob (memory_id, embedding)
         VALUES ($1, $2)
         ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [input.id, buf],
      );
      await this.query(
        `INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
         VALUES ($1,$2,'created',NULL,$3)`,
        [crypto.randomUUID(), input.id, input.createdAt],
      );
      return row;
    });
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryRow | null> {
    return this.withTransaction(async () => {
      const existing = await this.getMemoryById(input.id, input.organization);
      if (!existing) {
        return null;
      }
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : input.contentText !== undefined
            ? hashMemoryContent(input.contentText)
            : (existing.content_hash ?? null);
      await this.query(
        `UPDATE memories SET
          content_text = COALESCE($1, content_text),
          metadata_json = COALESCE($2::jsonb, metadata_json),
          content_hash = COALESCE($3, content_hash),
          updated_at = $4
         WHERE id = $5 AND organization = $6`,
        [
          input.contentText ?? null,
          input.metadata !== undefined ? serializeMetadata(input.metadata) : null,
          contentHash,
          input.updatedAt,
          input.id,
          input.organization,
        ],
      );
      if (input.embedding) {
        await this.deleteEmbedding(input.id);
        await this.insertEmbedding(input.id, input.embedding);
      }
      await this.query(
        `INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
         VALUES ($1,$2,'updated',NULL,$3)`,
        [crypto.randomUUID(), input.id, input.updatedAt],
      );
      return this.getMemoryById(input.id, input.organization);
    });
  }

  async findActiveByContentHash(
    organization: string,
    agent: string,
    contentHash: string,
  ): Promise<MemoryRow | null> {
    const result = await this.query(
      `SELECT id, organization, agent, content_text, metadata_json,
              archived::int AS archived, compressed_into, content_hash, created_at, updated_at
       FROM memories
       WHERE organization = $1 AND agent = $2 AND content_hash = $3 AND archived = false
       LIMIT 1`,
      [organization, agent, contentHash],
    );
    const row = result.rows[0];
    return row ? this.mapRow(row) : null;
  }

  async getMemoryById(id: string, organization: string): Promise<MemoryRow | null> {
    const result = await this.query(
      `SELECT id, organization, agent, content_text, metadata_json,
              archived::int AS archived, compressed_into, content_hash, created_at, updated_at
       FROM memories WHERE id = $1 AND organization = $2`,
      [id, organization],
    );
    const row = result.rows[0];
    return row ? this.mapRow(row) : null;
  }

  async getMemoryByRowid(rowid: number, organization: string): Promise<MemoryRow | null> {
    const result = await this.query(
      `SELECT m.id, m.organization, m.agent, m.content_text, m.metadata_json,
              m.archived::int AS archived, m.compressed_into, m.created_at, m.updated_at,
              e.row_num AS rowid
       FROM memories m
       JOIN memory_row_map e ON e.memory_id = m.id
       WHERE e.row_num = $1 AND m.organization = $2`,
      [rowid, organization],
    );
    const row = result.rows[0];
    return row ? this.mapRow(row) : null;
  }

  async getMemoriesByRowids(
    rowids: number[],
    organization: string,
  ): Promise<Map<number, MemoryRow>> {
    const out = new Map<number, MemoryRow>();
    if (rowids.length === 0) {
      return out;
    }
    const result = await this.query(
      `SELECT m.id, m.organization, m.agent, m.content_text, m.metadata_json,
              m.archived::int AS archived, m.compressed_into, m.created_at, m.updated_at,
              e.row_num AS rowid
       FROM memories m
       JOIN memory_row_map e ON e.memory_id = m.id
       WHERE m.organization = $1 AND e.row_num = ANY($2::bigint[])`,
      [organization, rowids],
    );
    for (const row of result.rows) {
      const mapped = this.mapRow(row);
      if (mapped.rowid !== undefined) {
        out.set(mapped.rowid, mapped);
      }
    }
    return out;
  }

  async listMemories(filter: RepositoryFilter, limit?: number): Promise<MemoryRow[]> {
    const want =
      limit !== undefined ? limit : filter.metadata ? 10_000 : undefined;
    const compiled = filter.metadata
      ? compileMetadataFilterToPostgres(filter.metadata, 2)
      : null;

    if (compiled) {
      const clauses = [`organization = $1`, `(${compiled.expression})`];
      const params: unknown[] = [filter.organization, ...compiled.params];
      let idx = params.length + 1;
      if (filter.agent) {
        clauses.push(`agent = $${idx++}`);
        params.push(filter.agent);
      }
      if (!filter.includeArchived) {
        clauses.push(`archived = false`);
      }
      let sql = `
        SELECT id, organization, agent, content_text, metadata_json,
               archived::int AS archived, compressed_into, created_at, updated_at
        FROM memories
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC
      `;
      if (want !== undefined) {
        sql += ` LIMIT $${idx}`;
        params.push(want);
      }
      const result = await this.query(sql, params);
      return result.rows.map((r) => this.mapRow(r));
    }

    const clauses = [`organization = $1`];
    const params: unknown[] = [filter.organization];
    let idx = 2;
    if (filter.agent) {
      clauses.push(`agent = $${idx++}`);
      params.push(filter.agent);
    }
    if (!filter.includeArchived) {
      clauses.push(`archived = false`);
    }
    let sql = `
      SELECT id, organization, agent, content_text, metadata_json,
             archived::int AS archived, compressed_into, created_at, updated_at
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
    `;
    if (limit !== undefined && !filter.metadata) {
      sql += ` LIMIT $${idx}`;
      params.push(limit);
    }
    const result = await this.query(sql, params);
    let rows = result.rows.map((r) => this.mapRow(r));
    if (filter.metadata) {
      rows = rows.filter((row) =>
        matchesMetadata(deserializeMetadata(row.metadata_json), filter.metadata!),
      );
      if (limit !== undefined) {
        rows = rows.slice(0, limit);
      }
    }
    return rows;
  }

  async searchByMetadata(
    filter: RepositoryFilter,
    limit?: number,
  ): Promise<MemoryRow[]> {
    return this.listMemories(filter, limit);
  }

  async searchKeyword(
    query: string,
    organization: string,
    topK: number,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    const trimmed = query.trim();
    if (!trimmed || topK <= 0) {
      return [];
    }
    try {
      const sql = this.hasContentTsv
        ? `SELECT id AS memory_id,
                  ts_rank(content_tsv, plainto_tsquery('english', $1)) AS rank
           FROM memories
           WHERE organization = $2
             AND archived = false
             AND content_tsv @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT $3`
        : `SELECT id AS memory_id,
                  ts_rank(to_tsvector('english', content_text), plainto_tsquery('english', $1)) AS rank
           FROM memories
           WHERE organization = $2
             AND archived = false
             AND to_tsvector('english', content_text) @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT $3`;
      const result = await this.query(sql, [trimmed, organization, topK]);
      return result.rows.map((row) => ({
        memoryId: String(row.memory_id),
        score: Number(row.rank),
      }));
    } catch (error) {
      if (!warnedFtsKeywordSearch) {
        warnedFtsKeywordSearch = true;
        warnLogger.warn(
          "FTS keyword search failed; returning empty keyword hits.",
          {
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return [];
    }
  }

  async searchVectors(
    embedding: Float32Array,
    topK: number,
  ): Promise<VectorSearchHit[]> {
    this.requireVectorReady();
    if (this.hasPgvector) {
      await this.ensureHnswIndex();
      return this.withSearchSession(async (client) => {
        const result = await client.query(
          `SELECT r.row_num AS memory_rowid, ann.distance
           FROM (
             SELECT e.memory_id, (e.embedding <=> $1::float4[]::vector) AS distance
             FROM memory_embeddings e
             WHERE e.archived = false
             ORDER BY e.embedding <=> $1::float4[]::vector
             LIMIT $2
           ) ann
           JOIN memory_row_map r ON r.memory_id = ann.memory_id
           ORDER BY ann.distance`,
          [toFloat4Param(embedding), topK],
        );
        const hits: VectorSearchHit[] = new Array(result.rows.length);
        for (let i = 0; i < result.rows.length; i += 1) {
          const row = result.rows[i]!;
          hits[i] = {
            memoryRowid: Number(row.memory_rowid),
            distance: Number(row.distance),
          };
        }
        return hits;
      });
    }

    const result = await this.query(
      `SELECT r.row_num AS memory_rowid, e.embedding
       FROM memory_embeddings_blob e
       JOIN memory_row_map r ON r.memory_id = e.memory_id`,
    );
    const scored = result.rows.map((row) => {
      const buf = row.embedding as Buffer;
      const vec = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      return {
        memoryRowid: Number(row.memory_rowid),
        distance: cosineDistance(embedding, vec),
      };
    });
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, topK);
  }

  async searchVectorsWithMemories(
    embedding: Float32Array,
    topK: number,
    organization: string,
    options?: { agent?: string; includeArchived?: boolean },
  ): Promise<Array<{ row: MemoryRow; distance: number }>> {
    this.requireVectorReady();
    if (!this.hasPgvector) {
      // Scope to organization before scoring — shared DBs accumulate many orgs
      // across a suite; global topK + post-filter underfills tenant recalls.
      const clauses = [`m.organization = $1`];
      const params: unknown[] = [organization];
      if (options?.agent) {
        clauses.push(`m.agent = $2`);
        params.push(options.agent);
      }
      if (!options?.includeArchived) {
        clauses.push(`m.archived = false`);
      }
      const result = await this.query(
        `SELECT m.id, m.organization, m.agent, m.content_text, m.metadata_json,
                m.archived::int AS archived, m.compressed_into, m.created_at, m.updated_at,
                r.row_num AS rowid, e.embedding
         FROM memory_embeddings_blob e
         JOIN memory_row_map r ON r.memory_id = e.memory_id
         JOIN memories m ON m.id = e.memory_id
         WHERE ${clauses.join(" AND ")}`,
        params,
      );
      const scored = result.rows.map((row) => {
        const buf = row.embedding as Buffer;
        const vec = new Float32Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        return {
          row: this.mapRow(row),
          distance: cosineDistance(embedding, vec),
        };
      });
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, topK);
    }

    await this.ensureHnswIndex();
    const vec = toFloat4Param(embedding);

    const mapHits = (
      rows: Record<string, unknown>[],
    ): Array<{ row: MemoryRow; distance: number }> =>
      rows.map((row) => ({
        row: this.mapRow(row),
        distance: Number(row.distance),
      }));

    // Org-scoped exact KNN — avoids filtered-HNSW iterative_scan tax when the
    // shared DB holds many tenants (common in long-lived Postgres). For typical
    // agent memory corpora (<~50k/org) this is faster and more predictable.
    const agentClause = options?.agent ? "AND e.agent = $4" : "";
    const archivedClause = options?.includeArchived
      ? ""
      : "AND e.archived = false";
    const params = options?.agent
      ? [vec, topK, organization, options.agent]
      : [vec, topK, organization];

    const result = await this.query(
      `SELECT m.id, m.organization, m.agent, m.content_text, m.metadata_json,
              m.archived::int AS archived, m.compressed_into, m.created_at, m.updated_at,
              r.row_num AS rowid,
              (e.embedding <=> $1::float4[]::vector) AS distance
       FROM memory_embeddings e
       JOIN memory_row_map r ON r.memory_id = e.memory_id
       JOIN memories m ON m.id = e.memory_id
       WHERE e.organization = $3
         ${agentClause}
         ${archivedClause}
         AND m.organization = $3
       ORDER BY e.embedding <=> $1::float4[]::vector
       LIMIT $2`,
      params,
    );
    return mapHits(result.rows);
  }

  async archiveMemories(
    ids: string[],
    organization: string,
    compressedIntoId: string,
    archivedAt: string,
  ): Promise<string[]> {
    return this.withTransaction(async () => {
      if (ids.length === 0) {
        return [];
      }
      const result = await this.query(
        `UPDATE memories
         SET archived = true, compressed_into = $1, updated_at = $2
         WHERE organization = $3 AND archived = false AND id = ANY($4::text[])
         RETURNING id`,
        [compressedIntoId, archivedAt, organization, ids],
      );
      const archived = result.rows.map((r) => String(r.id));
      if (archived.length === 0) {
        return [];
      }
      await this.query(
        `UPDATE memory_embeddings
         SET archived = true
         WHERE memory_id = ANY($1::text[])`,
        [archived],
      );
      const histIds: string[] = [];
      const memIds: string[] = [];
      const types: string[] = [];
      const related: string[] = [];
      const times: string[] = [];
      for (const id of archived) {
        histIds.push(crypto.randomUUID(), crypto.randomUUID());
        memIds.push(id, compressedIntoId);
        types.push("archived", "compressed");
        related.push(compressedIntoId, id);
        times.push(archivedAt, archivedAt);
      }
      await this.query(
        `INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
        [histIds, memIds, types, related, times],
      );
      return archived;
    });
  }

  async deleteMemoryById(id: string, organization: string): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM memories WHERE id = $1 AND organization = $2`,
      [id, organization],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMemoriesByFilter(filter: RepositoryFilter): Promise<number> {
    if (!filter.agent) {
      throw new DatabaseError("deleteMemoriesByFilter requires an agent filter");
    }
    const result = await this.query(
      `DELETE FROM memories WHERE organization = $1 AND agent = $2`,
      [filter.organization, filter.agent],
    );
    return result.rowCount ?? 0;
  }

  async clearOrganization(organization: string): Promise<number> {
    const result = await this.query(
      `DELETE FROM memories WHERE organization = $1`,
      [organization],
    );
    return result.rowCount ?? 0;
  }

  async getHistory(memoryId: string): Promise<HistoryRow[]> {
    const result = await this.query(
      `SELECT id, memory_id, event_type, related_memory_id, created_at
       FROM memory_history WHERE memory_id = $1 ORDER BY created_at ASC`,
      [memoryId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      memory_id: String(row.memory_id),
      event_type: row.event_type as HistoryRow["event_type"],
      related_memory_id:
        row.related_memory_id === null ? null : String(row.related_memory_id),
      created_at: String(row.created_at),
    }));
  }

  async insertHistoryEvent(event: HistoryRow): Promise<void> {
    await this.query(
      `INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        event.id,
        event.memory_id,
        event.event_type,
        event.related_memory_id,
        event.created_at,
      ],
    );
  }

  async getStats(
    organization: string,
  ): Promise<{
    totalMemories: number;
    activeMemories: number;
    archivedMemories: number;
    totalAgents: number;
  }> {
    const result = await this.query(
      `SELECT
         COUNT(*)::int AS memories,
         COUNT(*) FILTER (WHERE archived = false)::int AS active,
         COUNT(*) FILTER (WHERE archived = true)::int AS archived,
         COUNT(DISTINCT agent) FILTER (WHERE archived = false)::int AS agents
       FROM memories WHERE organization = $1`,
      [organization],
    );
    return {
      totalMemories: Number(result.rows[0]?.memories ?? 0),
      activeMemories: Number(result.rows[0]?.active ?? 0),
      archivedMemories: Number(result.rows[0]?.archived ?? 0),
      totalAgents: Number(result.rows[0]?.agents ?? 0),
    };
  }

  async getDatabaseSizeBytes(): Promise<number> {
    const result = await this.query(
      `SELECT pg_database_size(current_database())::bigint AS size`,
    );
    return Number(result.rows[0]?.size ?? 0);
  }

  async withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const existing = txStore.getStore();
    if (existing) {
      return fn();
    }
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const result = await txStore.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof DatabaseError || error instanceof InitializationError) {
        throw error;
      }
      throw new DatabaseError(`Transaction failed: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      client.release();
    }
  }

  private async runMigrations(): Promise<void> {
    // Split DDL: node-pg rejects multi-command prepared statements on some paths.
    await this.query(`
      CREATE TABLE IF NOT EXISTS Wolbarg_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `);

    const versionRow = await this.query(
      `SELECT value FROM Wolbarg_meta WHERE key = $1`,
      [META_KEYS.schemaVersion],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    const current =
      versionRow.rows[0]?.value !== undefined
        ? Number(versionRow.rows[0].value)
        : null;

    if (current !== null && current > SCHEMA_VERSION) {
      throw new InitializationError(
        `Database schema version ${current} is newer than this Wolbarg SDK (${SCHEMA_VERSION}). Please upgrade Wolbarg to open this database.`,
      );
    }

    // Fast path: schema already current — skip DDL churn and hash backfill.
    if (current === SCHEMA_VERSION) {
      const tsvProbe = await this.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'memories' AND column_name = 'content_tsv'
         LIMIT 1`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      this.hasContentTsv = tsvProbe.rows.length > 0;
      return;
    }

    await this.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY NOT NULL,
        organization TEXT NOT NULL,
        agent TEXT NOT NULL,
        content_text TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        archived BOOLEAN NOT NULL DEFAULT false,
        compressed_into TEXT NULL REFERENCES memories(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.query(`
      CREATE TABLE IF NOT EXISTS memory_history (
        id TEXT PRIMARY KEY NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'archived', 'compressed', 'updated')),
        related_memory_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.query(`
      CREATE TABLE IF NOT EXISTS memory_row_map (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        row_num BIGSERIAL UNIQUE NOT NULL
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_org_agent ON memories(organization, agent)`,
    );
    // Drop redundant archived btree — partial active indexes cover the hot path.
    await this.query(
      `DROP INDEX IF EXISTS idx_memories_org_archived`,
    ).catch(() => undefined);
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_org_active_created
       ON memories(organization, created_at) WHERE archived = false`,
    ).catch(() => undefined);
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_metadata ON memories USING GIN (metadata_json)`,
    );

    // Schema v3: content_hash + unique active index + history updated event
    await this.query(
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash TEXT`,
    ).catch(() => undefined);
    await this.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_org_agent_hash_active
       ON memories(organization, agent, content_hash)
       WHERE archived = false AND content_hash IS NOT NULL`,
    ).catch(() => undefined);
    await this.query(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        model TEXT NOT NULL,
        vector BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ NOT NULL
      )
    `).catch(() => undefined);

    // Widen history CHECK to allow 'updated' (drop + recreate constraint if present)
    await this.query(`
      DO $$
      BEGIN
        ALTER TABLE memory_history DROP CONSTRAINT IF EXISTS memory_history_event_type_check;
        ALTER TABLE memory_history ADD CONSTRAINT memory_history_event_type_check
          CHECK (event_type IN ('created', 'archived', 'compressed', 'updated'));
      EXCEPTION WHEN others THEN
        NULL;
      END $$;
    `).catch(() => undefined);

    // Backfill content_hash ONLY when upgrading from a pre-v3 schema.
    // Running this on every open() was the dominant cold-start cost (~100ms+).
    const priorVersion = await this.query(
      `SELECT value FROM Wolbarg_meta WHERE key = $1`,
      [META_KEYS.schemaVersion],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    const prior =
      priorVersion.rows[0]?.value !== undefined
        ? Number(priorVersion.rows[0].value)
        : null;
    const needsHashBackfill = prior === null || !Number.isFinite(prior) || prior < 3;

    if (needsHashBackfill) {
      const active = await this.query(
        `SELECT id, organization, agent, content_text, updated_at
         FROM memories WHERE archived = false AND content_hash IS NULL
         ORDER BY updated_at DESC`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      const seen = new Set<string>();
      for (const row of active.rows) {
        const hash = hashMemoryContent(String(row.content_text));
        const key = `${row.organization}\0${row.agent}\0${hash}`;
        if (seen.has(key)) {
          await this.query(
            `UPDATE memories SET content_hash = NULL WHERE id = $1`,
            [row.id],
          ).catch(() => undefined);
        } else {
          seen.add(key);
          await this.query(
            `UPDATE memories SET content_hash = $1 WHERE id = $2`,
            [hash, row.id],
          ).catch(() => undefined);
        }
      }
    }

    await this.query(
      `INSERT INTO Wolbarg_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [META_KEYS.schemaVersion, String(SCHEMA_VERSION)],
    ).catch(() => undefined);

    // Stored tsvector column — keyword/hybrid avoid re-computing to_tsvector.
    // Probe first: ALTER on every open is expensive when the column exists.
    const tsvProbe = await this.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'memories' AND column_name = 'content_tsv'
       LIMIT 1`,
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    if (tsvProbe.rows.length > 0) {
      this.hasContentTsv = true;
    } else {
      try {
        await this.query(`
          ALTER TABLE memories
          ADD COLUMN IF NOT EXISTS content_tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED
        `);
        await this.query(
          `CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING GIN (content_tsv)`,
        );
        this.hasContentTsv = true;
      } catch {
        await this.query(
          `CREATE INDEX IF NOT EXISTS idx_memories_fts
           ON memories USING GIN (to_tsvector('english', content_text))`,
        ).catch(() => undefined);
        this.hasContentTsv = false;
      }
    }
  }

  private async tryEnablePgvector(): Promise<boolean> {
    const cached = PostgresStorageProvider.pgvectorByConn.get(
      this.connectionString,
    );
    if (cached !== undefined) {
      return cached;
    }
    try {
      await this.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      PostgresStorageProvider.pgvectorByConn.set(this.connectionString, true);
      return true;
    } catch (error) {
      PostgresStorageProvider.pgvectorByConn.set(this.connectionString, false);
      if (!warnedPgvectorFallback) {
        warnedPgvectorFallback = true;
        warnLogger.warn(
          "pgvector extension is unavailable; using blob cosine search fallback.",
          {
            cause:
              error instanceof Error ? error.message : `unknown error: ${String(error)}`,
          },
        );
      }
      return false;
    }
  }

  private static pgvectorByConn = new Map<string, boolean>();
  private static vectorSchemaReady = new Set<string>();

  private async insertEmbedding(memoryId: string, embedding: Float32Array): Promise<void> {
    if (this.hasPgvector) {
      await this.query(
        `WITH mapped AS (
           INSERT INTO memory_row_map (memory_id) VALUES ($1)
           ON CONFLICT (memory_id) DO NOTHING
         ),
         meta AS (
           SELECT organization, agent, archived FROM memories WHERE id = $1
         )
         INSERT INTO memory_embeddings (memory_id, embedding, organization, agent, archived)
         SELECT $1, $2::float4[]::vector, meta.organization, meta.agent, meta.archived
         FROM meta
         ON CONFLICT (memory_id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           organization = EXCLUDED.organization,
           agent = EXCLUDED.agent,
           archived = EXCLUDED.archived`,
        [memoryId, toFloat4Param(embedding)],
      );
      return;
    }
    const buf = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    await this.query(
      `WITH mapped AS (
         INSERT INTO memory_row_map (memory_id) VALUES ($1)
         ON CONFLICT (memory_id) DO NOTHING
       )
       INSERT INTO memory_embeddings_blob (memory_id, embedding)
       VALUES ($1, $2)
       ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [memoryId, buf],
    );
  }

  private async deleteEmbedding(memoryId: string): Promise<void> {
    await this.query(`DELETE FROM memory_embeddings WHERE memory_id = $1`, [memoryId]).catch(() => undefined);
    await this.query(`DELETE FROM memory_embeddings_blob WHERE memory_id = $1`, [memoryId]).catch(() => undefined);
  }

  private async query(
    text: string,
    params?: unknown[],
  ): Promise<PgQueryResult> {
    const tx = txStore.getStore();
    const target: PgQueryable = tx ?? this.requirePool();
    return target.query(text, params);
  }

  /** Named prepared statement — parse/plan cached per pool connection. */
  private async queryNamed(
    name: string,
    text: string,
    params: unknown[],
  ): Promise<PgQueryResult> {
    const tx = txStore.getStore();
    const target: PgQueryable = tx ?? this.requirePool();
    return target.query({ name, text, values: params });
  }

  private mapRow(row: Record<string, unknown>): MemoryRow {
    const meta = row.metadata_json;
    let metadata_json: string;
    if (typeof meta === "string") {
      metadata_json = meta;
    } else if (meta && typeof meta === "object") {
      metadata_json = JSON.stringify(meta);
    } else {
      metadata_json = "{}";
    }

    const created =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at);
    const updated =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at);

    return {
      id: String(row.id),
      organization: String(row.organization),
      agent: String(row.agent),
      content_text: String(row.content_text),
      metadata_json,
      archived: Number(row.archived ?? 0),
      compressed_into:
        row.compressed_into === null || row.compressed_into === undefined
          ? null
          : String(row.compressed_into),
      content_hash:
        row.content_hash === null || row.content_hash === undefined
          ? null
          : String(row.content_hash),
      created_at: created,
      updated_at: updated,
      rowid: row.rowid !== undefined ? Number(row.rowid) : undefined,
    };
  }

  private requirePool(): PgPool {
    if (!this.pool) {
      throw new DatabaseError("Database is not open. Call open() first.");
    }
    return this.pool;
  }

  private requireVectorReady(): void {
    if (this.vectorDimensions === null) {
      throw new DatabaseError(
        "Vector index is not ready. Embedding dimensions have not been initialized.",
      );
    }
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      const aggregate = error as Error & { errors?: unknown[] };
      if (Array.isArray(aggregate.errors) && aggregate.errors.length > 0) {
        const nested = aggregate.errors
          .map((item) => (item instanceof Error ? item.message : String(item)))
          .join("; ");
        return `${error.message || error.name}: ${nested}`;
      }
      return error.message || error.name;
    }
    return String(error);
  }
}
