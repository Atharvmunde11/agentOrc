/**
 * PostgreSQL storage provider with optional pgvector support.
 * Requires the optional `pg` peer dependency.
 *
 * Performance design:
 * - Per-operation pool queries (no global write lock / shared tx client race)
 * - AsyncLocalStorage for nested transactions
 * - Single-statement CTE inserts (no BEGIN/COMMIT for one memory)
 * - Named prepared statements (parse/plan once per connection)
 * - Concurrent insert coalescing into unnest batches; sequential path is immediate
 * - COPY protocol for large ingest batches
 * - Org-filtered ANN with adaptive overfetch + HNSW iterative scan when available
 * - Joined vector search returning memories in one round-trip when possible
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseError, InitializationError, ConfigurationError } from "../../errors/index.js";
import { matchesMetadata } from "../../filters/match.js";
import { SCHEMA_VERSION, META_KEYS } from "../../schema/index.js";
import {
  deserializeMetadata,
  serializeMetadata,
} from "../../utils/index.js";
import { cosineDistance } from "../../utils/vector.js";
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
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

export interface PostgresProviderOptions {
  connectionString: string;
  maxPoolSize?: number;
}

const txStore = new AsyncLocalStorage<PgPoolClient>();

/** Statement names for per-connection prepared-statement cache. */
const STMT = {
  insertOne: "Wolbarg_insert_one_v1",
  insertBatch: "Wolbarg_insert_batch_v1",
} as const;

/** Fast Float32Array → pgvector text literal without Array.from. */
function toVectorLiteral(embedding: Float32Array): string {
  const n = embedding.length;
  let s = "[";
  for (let i = 0; i < n; i += 1) {
    if (i !== 0) s += ",";
    s += embedding[i];
  }
  return s + "]";
}

const INSERT_ONE_SQL = `WITH mem AS (
   INSERT INTO memories (
     id, organization, agent, content_text, metadata_json,
     archived, compressed_into, created_at, updated_at
   ) VALUES ($1,$2,$3,$4,$5::jsonb,false,NULL,$6,$7)
   RETURNING id, organization, agent, content_text, metadata_json,
             archived::int AS archived, compressed_into, created_at, updated_at
 ),
 hist AS (
   INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
   SELECT $8, id, 'created', NULL, $6 FROM mem
 ),
 mapped AS (
   INSERT INTO memory_row_map (memory_id)
   SELECT id FROM mem
   ON CONFLICT (memory_id) DO NOTHING
 ),
 emb AS (
   INSERT INTO memory_embeddings (memory_id, embedding)
   SELECT id, $9::vector FROM mem
   ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding
 )
 SELECT * FROM mem`;

const INSERT_BATCH_SQL = `WITH mem AS (
   INSERT INTO memories (
     id, organization, agent, content_text, metadata_json,
     archived, compressed_into, created_at, updated_at
   )
   SELECT id, org, agent, txt, meta::jsonb, false, NULL, c, u
   FROM unnest(
     $1::text[], $2::text[], $3::text[], $4::text[],
     $5::text[], $6::timestamptz[], $7::timestamptz[]
   ) AS t(id, org, agent, txt, meta, c, u)
   RETURNING id, organization, agent, content_text, metadata_json,
             archived::int AS archived, compressed_into, created_at, updated_at
 ),
 hist AS (
   INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
   SELECT h, m, 'created', NULL, c
   FROM unnest($8::text[], $1::text[], $6::timestamptz[]) AS t(h, m, c)
 ),
 mapped AS (
   INSERT INTO memory_row_map (memory_id)
   SELECT unnest($1::text[])
   ON CONFLICT (memory_id) DO NOTHING
 ),
 emb AS (
   INSERT INTO memory_embeddings (memory_id, embedding)
   SELECT id, emb::vector
   FROM unnest($1::text[], $9::text[]) AS t(id, emb)
   ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding
 )
 SELECT * FROM mem`;

const COPY_BATCH_THRESHOLD = 64;

export class PostgresStorageProvider implements StorageProvider {
  readonly name = "postgres";

  private readonly connectionString: string;
  private readonly maxPoolSize: number;
  private pool: PgPool | null = null;
  private vectorDimensions: number | null = null;
  private hasPgvector = false;
  private hnswIndexEnsured = false;
  private hnswCreateFailures = 0;
  private hasContentTsv = false;
  private iterativeScanEnabled = false;
  /** Coalesce concurrent insertMemory callers into one unnest batch. */
  private insertQueue: Array<{
    input: InsertMemoryInput;
    resolve: (row: MemoryRow) => void;
    reject: (err: unknown) => void;
  }> = [];
  private insertFlushScheduled = false;
  private insertFlushInFlight = false;

  constructor(options: PostgresProviderOptions) {
    this.connectionString = options.connectionString;
    // Default 32 — concurrent writers need pool headroom beyond the old max=10.
    this.maxPoolSize = options.maxPoolSize ?? 32;
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
        allowExitOnIdle: true,
        keepAlive: true,
      });
      await this.runMigrations();
      this.hasPgvector = await this.tryEnablePgvector();
      const dims = await this.getEmbeddingDimensions();
      if (dims !== null) {
        this.vectorDimensions = dims;
        await this.ensureVectorTables(dims);
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
    if (!this.pool) {
      return;
    }
    await this.pool.end();
    this.pool = null;
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
      // Do not create HNSW here — defer until first search so bulk inserts stay fast.
      // Do not DROP an existing index either (shared-DB benches would pay rebuild cost).
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
    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_hnsw
        ON memory_embeddings USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      this.hnswIndexEnsured = true;
      this.hnswCreateFailures = 0;
      // Prefer iterative filtered scans when the extension supports them.
      if (!this.iterativeScanEnabled) {
        try {
          await this.query(`SET hnsw.iterative_scan = relaxed_order`);
          this.iterativeScanEnabled = true;
        } catch {
          // Older pgvector — adaptive overfetch still guarantees correctness.
        }
      }
    } catch (error) {
      this.hnswCreateFailures += 1;
      if (this.hnswCreateFailures >= 3) {
        throw new DatabaseError(
          `Failed to create HNSW index after ${this.hnswCreateFailures} attempts: ${this.describe(error)}`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      // Leave hnswIndexEnsured=false so the next search retries.
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

    // Non-contended path: one CTE, zero event-loop delay (production sequential insert).
    if (!this.insertFlushInFlight && this.insertQueue.length === 0) {
      this.insertFlushInFlight = true;
      try {
        return await this.insertMemoryImmediate(input);
      } finally {
        this.insertFlushInFlight = false;
        if (this.insertQueue.length > 0) {
          this.insertFlushScheduled = true;
          queueMicrotask(() => {
            void this.flushInsertQueue();
          });
        }
      }
    }

    // Contended path: coalesce concurrent waiters into one unnest round-trip.
    return new Promise<MemoryRow>((resolve, reject) => {
      this.insertQueue.push({ input, resolve, reject });
      if (this.insertQueue.length >= 16) {
        if (this.insertFlushScheduled) {
          this.insertFlushScheduled = false;
        }
        void this.flushInsertQueue();
        return;
      }
      if (!this.insertFlushScheduled) {
        this.insertFlushScheduled = true;
        queueMicrotask(() => {
          void this.flushInsertQueue();
        });
      }
    });
  }

  private async flushInsertQueue(): Promise<void> {
    if (this.insertFlushInFlight) {
      // Another writer owns the flush; it will re-check the queue on exit.
      return;
    }
    const batch = this.insertQueue;
    this.insertQueue = [];
    this.insertFlushScheduled = false;
    if (batch.length === 0) {
      return;
    }
    this.insertFlushInFlight = true;
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
      this.insertFlushInFlight = false;
      if (this.insertQueue.length > 0) {
        this.insertFlushScheduled = true;
        queueMicrotask(() => {
          void this.flushInsertQueue();
        });
      } else {
        this.insertFlushScheduled = false;
      }
    }
  }

  /** Single-row insert without coalescing (used by flush + batch of 1). */
  private async insertMemoryImmediate(input: InsertMemoryInput): Promise<MemoryRow> {
    if (this.hasPgvector) {
      const inserted = await this.queryNamed(STMT.insertOne, INSERT_ONE_SQL, [
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        input.createdAt,
        input.updatedAt,
        crypto.randomUUID(),
        toVectorLiteral(input.embedding),
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
    const histIds = new Array<string>(inputs.length);
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
      histIds[i] = crypto.randomUUID();
      vectors[i] = toVectorLiteral(input.embedding);
    }

    const inserted = await this.queryNamed(STMT.insertBatch, INSERT_BATCH_SQL, [
      ids,
      orgs,
      agents,
      texts,
      metas,
      created,
      updated,
      histIds,
      vectors,
    ]);

    const byId = new Map(
      inserted.rows.map((r) => [String(r.id), this.mapRow(r)]),
    );
    return ids.map((id) => byId.get(id)!);
  }

  /** Split large ingest batches into parallel unnest chunks (pool pipelining). */
  private async insertBatchChunked(
    inputs: InsertMemoryInput[],
  ): Promise<MemoryRow[]> {
    const chunkSize = 128;
    if (inputs.length <= chunkSize) {
      return this.insertBatchPgvector(inputs);
    }
    const chunks: InsertMemoryInput[][] = [];
    for (let i = 0; i < inputs.length; i += chunkSize) {
      chunks.push(inputs.slice(i, i + chunkSize));
    }
    const results = await Promise.all(
      chunks.map((chunk) => this.insertBatchPgvector(chunk)),
    );
    const out: MemoryRow[] = new Array(inputs.length);
    let offset = 0;
    for (const part of results) {
      for (let i = 0; i < part.length; i += 1) {
        out[offset + i] = part[i]!;
      }
      offset += part.length;
    }
    return out;
  }

  private async insertOneBlob(input: InsertMemoryInput): Promise<MemoryRow> {
    const buf = Buffer.from(
      input.embedding.buffer,
      input.embedding.byteOffset,
      input.embedding.byteLength,
    );
    const inserted = await this.query(
      `INSERT INTO memories (
        id, organization, agent, content_text, metadata_json,
        archived, compressed_into, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,false,NULL,$6,$7)
      RETURNING id, organization, agent, content_text, metadata_json,
                archived::int AS archived, compressed_into, created_at, updated_at`,
      [
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        input.createdAt,
        input.updatedAt,
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
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryRow | null> {
    const existing = await this.getMemoryById(input.id, input.organization);
    if (!existing) {
      return null;
    }
    await this.query(
      `UPDATE memories SET
        content_text = COALESCE($1, content_text),
        metadata_json = COALESCE($2::jsonb, metadata_json),
        updated_at = $3
       WHERE id = $4 AND organization = $5`,
      [
        input.contentText ?? null,
        input.metadata !== undefined ? serializeMetadata(input.metadata) : null,
        input.updatedAt,
        input.id,
        input.organization,
      ],
    );
    if (input.embedding) {
      await this.deleteEmbedding(input.id);
      await this.insertEmbedding(input.id, input.embedding);
    }
    return this.getMemoryById(input.id, input.organization);
  }

  async getMemoryById(id: string, organization: string): Promise<MemoryRow | null> {
    const result = await this.query(
      `SELECT id, organization, agent, content_text, metadata_json,
              archived::int AS archived, compressed_into, created_at, updated_at
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
    } catch {
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
      const result = await this.query(
        `SELECT r.row_num AS memory_rowid, ann.distance
         FROM (
           SELECT e.memory_id, (e.embedding <=> $1::vector) AS distance
           FROM memory_embeddings e
           ORDER BY e.embedding <=> $1::vector
           LIMIT $2
         ) ann
         JOIN memory_row_map r ON r.memory_id = ann.memory_id
         ORDER BY ann.distance`,
        [toVectorLiteral(embedding), topK],
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
      const hits = await this.searchVectors(embedding, topK);
      const map = await this.getMemoriesByRowids(
        hits.map((h) => h.memoryRowid),
        organization,
      );
      const out: Array<{ row: MemoryRow; distance: number }> = [];
      for (const hit of hits) {
        const row = map.get(hit.memoryRowid);
        if (!row) continue;
        if (options?.agent && row.agent !== options.agent) continue;
        if (!options?.includeArchived && row.archived === 1) continue;
        out.push({ row, distance: hit.distance });
      }
      return out;
    }

    await this.ensureHnswIndex();
    const vec = toVectorLiteral(embedding);

    const mapHits = (
      rows: Record<string, unknown>[],
    ): Array<{ row: MemoryRow; distance: number }> =>
      rows.map((row) => ({
        row: this.mapRow(row),
        distance: Number(row.distance),
      }));

    // Subquery-first ANN keeps HNSW eligible. Start with a modest overfetch so
    // shared/multi-tenant corpora still fill topK after org post-filter without
    // many round-trips. Expand only when still under-filled.
    let overfetch = Math.min(Math.max(topK * 8, topK), 512);
    const maxFetch = Math.min(Math.max(topK * 64, 512), 8192);
    for (;;) {
      const agentClause = options?.agent ? "AND m.agent = $5" : "";
      const archivedClause = options?.includeArchived ? "" : "AND m.archived = false";
      const params = options?.agent
        ? [vec, overfetch, organization, topK, options.agent]
        : [vec, overfetch, organization, topK];
      const ann = await this.query(
        `WITH ann AS (
           SELECT e.memory_id, (e.embedding <=> $1::vector) AS distance
           FROM memory_embeddings e
           ORDER BY e.embedding <=> $1::vector
           LIMIT $2
         )
         SELECT m.id, m.organization, m.agent, m.content_text, m.metadata_json,
                m.archived::int AS archived, m.compressed_into, m.created_at, m.updated_at,
                r.row_num AS rowid,
                ann.distance,
                (SELECT COUNT(*)::int FROM ann) AS ann_fetched
         FROM ann
         JOIN memory_row_map r ON r.memory_id = ann.memory_id
         JOIN memories m ON m.id = ann.memory_id
         WHERE m.organization = $3
           ${agentClause}
           ${archivedClause}
         ORDER BY ann.distance
         LIMIT $4`,
        params,
      );

      const annFetched = Number(ann.rows[0]?.ann_fetched ?? ann.rows.length);
      if (
        ann.rows.length >= topK ||
        annFetched < overfetch ||
        overfetch >= maxFetch
      ) {
        return mapHits(ann.rows.slice(0, topK));
      }
      const next = Math.min(overfetch * 4, maxFetch);
      if (next === overfetch) {
        return mapHits(ann.rows.slice(0, topK));
      }
      overfetch = next;
    }
  }

  async archiveMemories(
    ids: string[],
    organization: string,
    compressedIntoId: string,
    archivedAt: string,
  ): Promise<string[]> {
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
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'archived', 'compressed')),
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
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_org_archived ON memories(organization, archived)`,
    );
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_org_active_created
       ON memories(organization, created_at) WHERE archived = false`,
    ).catch(() => undefined);
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_metadata ON memories USING GIN (metadata_json)`,
    );

    // Stored tsvector column — keyword/hybrid avoid re-computing to_tsvector.
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

    const versionRow = await this.query(
      `SELECT value FROM Wolbarg_meta WHERE key = $1`,
      [META_KEYS.schemaVersion],
    );
    if (!versionRow.rows[0]) {
      await this.query(
        `INSERT INTO Wolbarg_meta (key, value) VALUES ($1, $2)`,
        [META_KEYS.schemaVersion, String(SCHEMA_VERSION)],
      );
    }
  }

  private async tryEnablePgvector(): Promise<boolean> {
    try {
      await this.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      return true;
    } catch {
      return false;
    }
  }

  private async insertEmbedding(memoryId: string, embedding: Float32Array): Promise<void> {
    if (this.hasPgvector) {
      await this.query(
        `WITH mapped AS (
           INSERT INTO memory_row_map (memory_id) VALUES ($1)
           ON CONFLICT (memory_id) DO NOTHING
         )
         INSERT INTO memory_embeddings (memory_id, embedding)
         VALUES ($1, $2::vector)
         ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [memoryId, toVectorLiteral(embedding)],
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
