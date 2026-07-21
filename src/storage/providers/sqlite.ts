/**
 * SQLite + sqlite-vec database provider (Node.js built-in `node:sqlite`).
 *
 * Responsibilities:
 * - WAL mode + crash-safe pragmas
 * - Automatic migrations / schema creation
 * - Prepared statements
 * - ACID transactions
 * - Vector index via sqlite-vec vec0 when available
 * - Blob + cosine fallback on unsupported platforms (e.g. win32-arm64)
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

import { DatabaseError, InitializationError } from "../../errors/index.js";
import { matchesMetadata } from "../../filters/match.js";
import { compileMetadataFilterToSql } from "../../filters/sql-compile.js";
import { WolbargLogger } from "../../telemetry/logger.js";
import {
  CREATE_BLOB_EMBEDDINGS_TABLE,
  CREATE_EMBEDDING_CACHE_TABLE,
  CREATE_FTS_TABLE,
  CREATE_HISTORY_TABLE,
  CREATE_INDEXES,
  CREATE_MEMORIES_TABLE,
  CREATE_META_TABLE,
  DROP_REDUNDANT_INDEXES_V4,
  META_KEYS,
  SCHEMA_VERSION,
  buildVectorTableSql,
  type VectorBackend,
} from "../../schema/index.js";
import { SQL } from "../../sql/index.js";
import {
  deserializeMetadata,
  embeddingToBuffer,
  serializeMetadata,
} from "../../utils/index.js";
import { bufferToEmbedding } from "../../utils/vector.js";
import {
  InMemoryVectorIndex,
  normalizeEmbedding,
} from "../../utils/vector-index.js";
import type {
  HistoryRow,
  InsertMemoryInput,
  MemoryRow,
  RepositoryFilter,
  StorageProvider,
  UpdateMemoryInput,
  VectorSearchHit,
} from "../types.js";
import {
  resolveConcurrencyConfig,
  type ConcurrencyConfig,
  type ResolvedConcurrencyConfig,
} from "../sqlite/concurrency-config.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";
import { hashMemoryContent } from "../../memory/dedupe.js";

/** Hard cap when metadata cannot be fully pushed to SQL (prevents O(n) RAM blowups). */
const MAX_METADATA_SCAN = 50_000;
const METADATA_PAGE_SIZE = 500;
/**
 * Multi-row INSERT chunk size. SQLite default bind limit is 999; 9 binds/row → 110.
 * Leave headroom for side-table multi-value inserts in the same transaction.
 */
const BATCH_INSERT_CHUNK = 96;
/** Max ANN overfetch when post-filtering by org/agent/archived. */
const MAX_ANN_OVERFETCH = 8192;
/** Coalesce concurrent single-row inserts (multi-writer throughput). */
const INSERT_COALESCE_THRESHOLD = 24;
const INSERT_COALESCE_MAX = 96;

const warnLogger = new WolbargLogger("warn");
let warnedSqliteVecFallback = false;
let warnedFtsKeywordSearch = false;

interface PreparedStatements {
  getMeta: StatementSync;
  setMeta: StatementSync;
  insertMemory: StatementSync;
  updateMemoryContent: StatementSync;
  getMemoryById: StatementSync;
  getMemoryByRowid: StatementSync;
  findActiveByContentHash: StatementSync;
  insertEmbedding: StatementSync | null;
  deleteEmbedding: StatementSync | null;
  searchVectors: StatementSync | null;
  insertEmbeddingBlob: StatementSync | null;
  deleteEmbeddingBlob: StatementSync | null;
  listEmbeddingsBlob: StatementSync | null;
  archiveMemory: StatementSync;
  deleteMemoryById: StatementSync;
  deleteMemoriesByOrg: StatementSync;
  deleteMemoriesByOrgAgent: StatementSync;
  insertHistory: StatementSync;
  getHistory: StatementSync;
  getStats: StatementSync;
  listRowidsForOrg: StatementSync;
  listRowidsForOrgAgent: StatementSync;
  vectorTableExists: StatementSync;
  blobTableExists: StatementSync;
  insertFts: StatementSync | null;
  deleteFts: StatementSync | null;
  deleteFtsByOrg: StatementSync | null;
  deleteFtsByOrgAgent: StatementSync | null;
  searchFts: StatementSync | null;
  deleteEmbeddingsByOrg: StatementSync | null;
  deleteEmbeddingsByOrgAgent: StatementSync | null;
  deleteEmbeddingsBlobByOrg: StatementSync | null;
  deleteEmbeddingsBlobByOrgAgent: StatementSync | null;
}

export interface SqliteProviderOptions {
  connectionString: string;
  concurrency?: ConcurrencyConfig;
}

export class SqliteStorageProvider implements StorageProvider {
  readonly name = "sqlite";

  private readonly connectionString: string;
  private readonly concurrency: ResolvedConcurrencyConfig;
  private db: DatabaseSync | null = null;
  private statements: PreparedStatements | null = null;
  private vectorDimensions: number | null = null;
  private vectorBackend: VectorBackend | null = null;
  private sqliteVecLoaded = false;
  /** Tracks nesting depth for {@link withTransaction} so we can use savepoints. */
  private transactionDepth = 0;
  /** Incrementing counter for deterministic savepoint names. */
  private savepointCounter = 0;
  /** Hot in-process ANN for blob backend (sqlite-vec unavailable platforms). */
  private memoryIndex: InMemoryVectorIndex | null = null;
  private memoryIndexDirty = false;
  /** Resolved absolute path (or `:memory:`) — avoid re-resolving on size checks. */
  private resolvedPath: string | null = null;
  private retryLog: ((msg: string) => void) | null = null;
  /** Cached prepared statements for `rowid IN (…)` lookups keyed by list length. */
  private rowidInStatements = new Map<number, StatementSync>();
  /** Cached list SQL statements keyed by clause shape. */
  private listStatements = new Map<string, StatementSync>();
  /** Cached multi-row insert statements keyed by row count. */
  private batchInsertStatements = new Map<number, StatementSync>();
  /** Cached multi-row history inserts keyed by row count. */
  private batchHistoryStatements = new Map<number, StatementSync>();
  /** Cached multi-row FTS inserts keyed by row count. */
  private batchFtsStatements = new Map<number, StatementSync>();
  /** Cached multi-row blob embedding inserts keyed by row count. */
  private batchBlobEmbStatements = new Map<number, StatementSync>();
  /** Coalesce concurrent insertMemory callers into one IMMEDIATE transaction. */
  private insertQueue: Array<{
    input: InsertMemoryInput;
    resolve: (row: MemoryRow) => void;
    reject: (err: unknown) => void;
  }> = [];
  private insertFlushScheduled = false;

  constructor(options: SqliteProviderOptions) {
    this.connectionString = options.connectionString;
    this.concurrency = resolveConcurrencyConfig(options.concurrency);
  }

  /** Absolute or relative path / `:memory:` used by this provider. */
  get path(): string {
    return this.connectionString;
  }

  /** Expose DB for embedding cache store (same connection). */
  getDatabase(): DatabaseSync | null {
    return this.db;
  }

  setRetryLogger(fn: ((msg: string) => void) | null): void {
    this.retryLog = fn;
  }

  async open(): Promise<void> {
    try {
      const dbPath = this.resolvePath(this.connectionString);
      this.resolvedPath = dbPath;
      if (dbPath !== ":memory:") {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }

      const db = new DatabaseSync(dbPath, { allowExtension: true });
      this.db = db;

      // WAL + NORMAL is the production-safe default (multi-reader friendly).
      // Single-process SDK keeps locking_mode=NORMAL (not EXCLUSIVE) so other
      // tools/processes can open the same file for backups or inspection.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${this.concurrency.lockTimeoutMs};
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -32768;
        PRAGMA mmap_size = 134217728;
        PRAGMA wal_autocheckpoint = 2000;
        PRAGMA recursive_triggers = OFF;
      `);

      this.sqliteVecLoaded = this.tryLoadSqliteVec(db);
      this.runMigrations(db);
      this.statements = this.prepareStatements(db);
      // FTS consistency check only on fresh / upgraded DBs (see runMigrations).
      // Re-scanning every warm open costs measurable ms for no benefit.

      const backend = this.readMetaString(META_KEYS.vectorBackend) as VectorBackend | null;
      const dims = this.readMetaNumber(META_KEYS.embeddingDimensions);

      if (backend) {
        this.vectorBackend = backend;
      } else if (this.sqliteVecLoaded) {
        this.vectorBackend = "sqlite-vec";
      } else {
        if (!warnedSqliteVecFallback) {
          warnedSqliteVecFallback = true;
          warnLogger.warn(
            "sqlite-vec unavailable on this platform; using blob ANN fallback.",
          );
        }
        this.vectorBackend = "blob";
      }

      if (dims !== null) {
        this.vectorDimensions = dims;
        this.ensureVectorStorage(dims);
        this.reprepareVectorStatements();
        // Blob ANN hydrate is deferred until first search (warm-start win).
        if (this.vectorBackend === "blob") {
          this.memoryIndexDirty = true;
        }
      }
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        // ignore close errors during failed open
      }
      this.db = null;
      this.statements = null;
      throw new InitializationError(
        `Failed to open SQLite database: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async close(): Promise<void> {
    // Drain coalesced inserts before tearing down the connection.
    const deadline = Date.now() + 2_000;
    while (this.insertQueue.length > 0 && Date.now() < deadline) {
      await this.flushInsertQueue();
    }
    if (!this.db) {
      return;
    }
    try {
      // Refresh query planner stats before close (cheap; measurable on large DBs).
      try {
        this.db.exec("PRAGMA optimize;");
      } catch {
        // ignore — optimize is best-effort
      }
      this.db.close();
    } catch (error) {
      throw new DatabaseError(`Failed to close database: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      this.db = null;
      this.statements = null;
      this.memoryIndex = null;
      this.rowidInStatements.clear();
      this.listStatements.clear();
      this.batchInsertStatements.clear();
      this.batchHistoryStatements.clear();
      this.batchFtsStatements.clear();
      this.batchBlobEmbStatements.clear();
    }
  }

  async ensureVectorSchema(dimensions: number): Promise<void> {
    const existing = await this.getEmbeddingDimensions();
    if (existing !== null && existing !== dimensions) {
      throw new InitializationError(
        `Embedding dimensions mismatch: database is configured for ${existing}-d vectors, but the embedding model returned ${dimensions}-d vectors.`,
      );
    }

    if (!this.vectorBackend) {
      this.vectorBackend = this.sqliteVecLoaded ? "sqlite-vec" : "blob";
    }

    // Prefer sqlite-vec when available and not already locked to blob.
    if (this.sqliteVecLoaded && this.vectorBackend !== "blob") {
      this.vectorBackend = "sqlite-vec";
    }

    this.ensureVectorStorage(dimensions);
    await this.setMeta(META_KEYS.vectorBackend, this.vectorBackend);

    if (existing === null) {
      await this.setEmbeddingDimensions(dimensions);
    }
    this.vectorDimensions = dimensions;
    this.reprepareVectorStatements();
    this.hydrateMemoryIndex();
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    return this.readMetaNumber(META_KEYS.embeddingDimensions);
  }

  async setEmbeddingDimensions(dimensions: number): Promise<void> {
    await this.setMeta(META_KEYS.embeddingDimensions, String(dimensions));
    this.vectorDimensions = dimensions;
  }

  async insertMemory(input: InsertMemoryInput): Promise<MemoryRow> {
    this.requireVectorReady();
    // Coalesce concurrent writers into one BEGIN IMMEDIATE + multi-row insert.
    // Without this, each remember() pays a full fsync-bound commit.
    return new Promise<MemoryRow>((resolve, reject) => {
      this.insertQueue.push({ input, resolve, reject });
      if (this.insertQueue.length >= INSERT_COALESCE_THRESHOLD) {
        this.insertFlushScheduled = false;
        void this.flushInsertQueue();
        return;
      }
      this.scheduleInsertFlush();
    });
  }

  private scheduleInsertFlush(): void {
    if (this.insertFlushScheduled) {
      return;
    }
    this.insertFlushScheduled = true;
    // setImmediate lets concurrent remember() callers join one IMMEDIATE tx.
    setImmediate(() => {
      this.insertFlushScheduled = false;
      void this.flushInsertQueue();
    });
  }

  private async flushInsertQueue(): Promise<void> {
    if (this.insertQueue.length === 0) {
      return;
    }
    const batch = this.insertQueue.splice(0, INSERT_COALESCE_MAX);
    try {
      if (batch.length === 1) {
        const row = await this.insertMemoryImmediate(batch[0]!.input);
        batch[0]!.resolve(row);
      } else {
        const rows = await this.insertMemoriesBatch(batch.map((b) => b.input));
        for (let i = 0; i < batch.length; i += 1) {
          batch[i]!.resolve(rows[i]!);
        }
      }
    } catch (error) {
      for (const item of batch) {
        item.reject(error);
      }
    }
    if (this.insertQueue.length > 0) {
      void this.flushInsertQueue();
    }
  }

  /** Single-row insert without coalescing (used by flush of size 1). */
  private async insertMemoryImmediate(input: InsertMemoryInput): Promise<MemoryRow> {
    const stmts = this.requireStatements();
    const contentHash =
      input.contentHash !== undefined
        ? input.contentHash
        : hashMemoryContent(input.contentText);

    return this.withTransaction(() => {
      const row = stmts.insertMemory.get(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        contentHash,
        input.createdAt,
        input.updatedAt,
      ) as unknown as MemoryRow | undefined;
      if (!row || row.rowid === undefined) {
        throw new DatabaseError("Failed to read memory after insert");
      }

      this.insertEmbedding(row.rowid, input.embedding);
      // Keep FTS in the same ACID transaction — no deferred/stale keyword search.
      this.insertFtsRow(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
      );

      stmts.insertHistory.run(
        crypto.randomUUID(),
        input.id,
        "created",
        null,
        input.createdAt,
      );

      return row;
    });
  }

  async insertMemoriesBatch(inputs: InsertMemoryInput[]): Promise<MemoryRow[]> {
    if (inputs.length === 0) {
      return [];
    }
    this.requireVectorReady();

    return this.withTransaction(() => {
      const rows: MemoryRow[] = [];
      for (let offset = 0; offset < inputs.length; offset += BATCH_INSERT_CHUNK) {
        const chunk = inputs.slice(offset, offset + BATCH_INSERT_CHUNK);
        const inserted = this.insertMemoryChunk(chunk);
        rows.push(...inserted);
      }
      return rows;
    });
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryRow | null> {
    const stmts = this.requireStatements();
    return this.withTransaction(() => {
      const existing = stmts.getMemoryById.get(
        input.id,
        input.organization,
      ) as unknown as MemoryRow | undefined;
      if (!existing || existing.rowid === undefined) {
        return null;
      }

      const contentText = input.contentText ?? existing.content_text;
      const metadataJson =
        input.metadata !== undefined
          ? serializeMetadata(input.metadata)
          : existing.metadata_json;
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : input.contentText !== undefined
            ? hashMemoryContent(input.contentText)
            : (existing.content_hash ?? null);

      stmts.updateMemoryContent.run(
        input.contentText ?? null,
        input.metadata !== undefined ? metadataJson : null,
        contentHash,
        input.updatedAt,
        input.id,
        input.organization,
      );

      if (input.embedding) {
        this.deleteEmbedding(existing.rowid);
        this.insertEmbedding(existing.rowid, input.embedding);
      }

      if (input.contentText !== undefined) {
        this.upsertFts(
          input.id,
          input.organization,
          existing.agent,
          contentText,
        );
      }

      stmts.insertHistory.run(
        crypto.randomUUID(),
        input.id,
        "updated",
        null,
        input.updatedAt,
      );

      return stmts.getMemoryById.get(input.id, input.organization) as unknown as MemoryRow;
    });
  }

  async findActiveByContentHash(
    organization: string,
    agent: string,
    contentHash: string,
  ): Promise<MemoryRow | null> {
    const stmts = this.requireStatements();
    const row = stmts.findActiveByContentHash.get(
      organization,
      agent,
      contentHash,
    ) as unknown as MemoryRow | undefined;
    return row ?? null;
  }

  async searchByMetadata(
    filter: RepositoryFilter,
    limit?: number,
  ): Promise<MemoryRow[]> {
    const rows = await this.listMemories(filter, limit);
    if (!filter.metadata) {
      return rows;
    }
    return rows.filter((row) =>
      matchesMetadata(deserializeMetadata(row.metadata_json), filter.metadata!),
    );
  }

  /** Keyword search via FTS5 BM25. Returns memory IDs ranked by relevance. */
  async searchKeyword(
    query: string,
    organization: string,
    topK: number,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    const stmts = this.requireStatements();
    if (!stmts.searchFts) {
      if (!warnedFtsKeywordSearch) {
        warnedFtsKeywordSearch = true;
        warnLogger.warn(
          "FTS keyword search is unavailable; returning empty keyword hits.",
        );
      }
      return [];
    }
    try {
      const sanitized = sanitizeFtsQuery(query);
      if (!sanitized) {
        return [];
      }
      const rows = stmts.searchFts.all(sanitized, organization, topK) as unknown as Array<{
        memory_id: string;
        rank: number;
      }>;
      return rows.map((row) => ({
        memoryId: row.memory_id,
        // bm25 returns lower (more negative) for better matches — invert to [0, ∞)
        score: 1 / (1 + Math.abs(row.rank)),
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

  async getMemoryById(
    id: string,
    organization: string,
  ): Promise<MemoryRow | null> {
    const stmts = this.requireStatements();
    const row = stmts.getMemoryById.get(id, organization) as unknown as
      | MemoryRow
      | undefined;
    return row ?? null;
  }

  async getMemoryByRowid(
    rowid: number,
    organization: string,
  ): Promise<MemoryRow | null> {
    const stmts = this.requireStatements();
    const row = stmts.getMemoryByRowid.get(rowid, organization) as unknown as
      | MemoryRow
      | undefined;
    return row ?? null;
  }

  async getMemoriesByRowids(
    rowids: number[],
    organization: string,
  ): Promise<Map<number, MemoryRow>> {
    const out = new Map<number, MemoryRow>();
    if (rowids.length === 0) {
      return out;
    }
    const chunkSize = 400;
    for (let offset = 0; offset < rowids.length; offset += chunkSize) {
      const chunk = rowids.slice(offset, offset + chunkSize);
      const stmt = this.getRowidInStatement(chunk.length);
      const rows = stmt.all(organization, ...chunk) as unknown as MemoryRow[];
      for (const row of rows) {
        if (row.rowid !== undefined) {
          out.set(row.rowid, row);
        }
      }
    }
    return out;
  }

  async listMemories(
    filter: RepositoryFilter,
    limit?: number,
  ): Promise<MemoryRow[]> {
    try {
      if (filter.metadata) {
        return this.listMemoriesWithMetadata(filter, limit);
      }
      return this.listMemoriesIndexed(filter, limit);
    } catch (error) {
      throw new DatabaseError(`Failed to list memories: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async searchVectors(
    embedding: Float32Array,
    topK: number,
  ): Promise<VectorSearchHit[]> {
    this.requireVectorReady();

    if (this.vectorBackend === "sqlite-vec") {
      return this.searchWithSqliteVec(embedding, topK);
    }
    return this.searchWithBlobFallback(embedding, topK);
  }

  /**
   * Org-scoped KNN + memory rows with adaptive overfetch.
   * Global ANN is post-filtered by org/agent/archived; underfill triggers larger k.
   */
  async searchVectorsWithMemories(
    embedding: Float32Array,
    topK: number,
    organization: string,
    options?: { agent?: string; includeArchived?: boolean },
  ): Promise<Array<{ row: MemoryRow; distance: number }>> {
    this.requireVectorReady();
    if (topK <= 0) {
      return [];
    }

    let fetchK = topK;
    const maxFetch = Math.min(Math.max(topK * 64, 512), MAX_ANN_OVERFETCH);
    let out: Array<{ row: MemoryRow; distance: number }> = [];

    while (true) {
      const hits = await this.searchVectors(embedding, fetchK);
      if (hits.length === 0) {
        return [];
      }
      const map = await this.getMemoriesByRowids(
        hits.map((h) => h.memoryRowid),
        organization,
      );
      out = [];
      for (const hit of hits) {
        const row = map.get(hit.memoryRowid);
        if (!row) continue;
        if (options?.agent && row.agent !== options.agent) continue;
        if (!options?.includeArchived && row.archived === 1) continue;
        out.push({ row, distance: hit.distance });
        if (out.length >= topK) {
          return out;
        }
      }
      if (hits.length < fetchK) {
        break;
      }
      if (fetchK >= maxFetch) {
        break;
      }
      fetchK = Math.min(fetchK * 4, maxFetch);
    }
    return out;
  }

  async archiveMemories(
    ids: string[],
    organization: string,
    compressedIntoId: string,
    archivedAt: string,
  ): Promise<string[]> {
    const stmts = this.requireStatements();
    const archived: string[] = [];

    return this.withTransaction(() => {
      for (const id of ids) {
        const existing = stmts.getMemoryById.get(id, organization) as unknown as
          | MemoryRow
          | undefined;
        const result = stmts.archiveMemory.run(
          compressedIntoId,
          archivedAt,
          id,
          organization,
        );
        if (Number(result.changes) > 0) {
          archived.push(id);
          // Drop from ANN + FTS so recall never resurfaces archived rows.
          if (existing?.rowid !== undefined) {
            this.deleteEmbedding(existing.rowid);
          }
          this.deleteFts(id);
          stmts.insertHistory.run(
            crypto.randomUUID(),
            id,
            "archived",
            compressedIntoId,
            archivedAt,
          );
          stmts.insertHistory.run(
            crypto.randomUUID(),
            compressedIntoId,
            "compressed",
            id,
            archivedAt,
          );
        }
      }
      return archived;
    });
  }

  async deleteMemoryById(id: string, organization: string): Promise<boolean> {
    const stmts = this.requireStatements();

    return this.withTransaction(() => {
      const row = stmts.getMemoryById.get(id, organization) as unknown as
        | MemoryRow
        | undefined;
      if (!row || row.rowid === undefined) {
        return false;
      }

      this.deleteEmbedding(row.rowid);
      this.deleteFts(id);
      const result = stmts.deleteMemoryById.run(id, organization);
      return Number(result.changes) > 0;
    });
  }

  async deleteMemoriesByFilter(filter: RepositoryFilter): Promise<number> {
    const stmts = this.requireStatements();
    const agent = filter.agent;
    if (!agent) {
      throw new DatabaseError("deleteMemoriesByFilter requires an agent filter");
    }

    return this.withTransaction(() => {
      this.deleteEmbeddingsForScope(filter.organization, agent);
      this.deleteFtsForScope(filter.organization, agent);
      const result = stmts.deleteMemoriesByOrgAgent.run(
        filter.organization,
        agent,
      );
      return Number(result.changes);
    });
  }

  async clearOrganization(organization: string): Promise<number> {
    const stmts = this.requireStatements();

    return this.withTransaction(() => {
      this.deleteEmbeddingsForScope(organization);
      this.deleteFtsForScope(organization);
      const result = stmts.deleteMemoriesByOrg.run(organization);
      // Remove orphaned blob rows (memories may already be empty).
      try {
        this.requireDb().exec(`
          DELETE FROM memory_embeddings_blob
          WHERE memory_rowid NOT IN (SELECT rowid FROM memories)
        `);
      } catch {
        // ignore if blob table missing
      }
      return Number(result.changes);
    });
  }

  async getHistory(memoryId: string): Promise<HistoryRow[]> {
    const stmts = this.requireStatements();
    return stmts.getHistory.all(memoryId) as unknown as HistoryRow[];
  }

  async insertHistoryEvent(event: HistoryRow): Promise<void> {
    const stmts = this.requireStatements();
    stmts.insertHistory.run(
      event.id,
      event.memory_id,
      event.event_type,
      event.related_memory_id,
      event.created_at,
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
    const stmts = this.requireStatements();
    const row = stmts.getStats.get(organization) as unknown as {
      total: number | bigint;
      active: number | bigint;
      archived: number | bigint;
      agents: number | bigint;
    };
    return {
      totalMemories: Number(row.total),
      activeMemories: Number(row.active),
      archivedMemories: Number(row.archived),
      totalAgents: Number(row.agents),
    };
  }

  async getDatabaseSizeBytes(): Promise<number> {
    const db = this.requireDb();
    if (this.connectionString === ":memory:") {
      const pageCountRow = db.prepare("PRAGMA page_count").get() as
        | Record<string, number | bigint>
        | undefined;
      const pageSizeRow = db.prepare("PRAGMA page_size").get() as
        | Record<string, number | bigint>
        | undefined;
      const pageCount = Number(
        pageCountRow?.page_count ?? Object.values(pageCountRow ?? {})[0] ?? 0,
      );
      const pageSize = Number(
        pageSizeRow?.page_size ?? Object.values(pageSizeRow ?? {})[0] ?? 0,
      );
      return pageCount * pageSize;
    }

    const dbPath = this.resolvedPath ?? this.resolvePath(this.connectionString);
    try {
      let total = fs.statSync(dbPath).size;
      for (const suffix of ["-wal", "-shm"]) {
        const side = `${dbPath}${suffix}`;
        if (fs.existsSync(side)) {
          total += fs.statSync(side).size;
        }
      }
      return total;
    } catch (error) {
      throw new DatabaseError(
        `Failed to determine database size: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const db = this.requireDb();
    // Nested writes can happen (e.g. compress() wrapping storage.withTransaction()
    // while provider methods also use withTransaction internally).
    // SQLite forbids BEGIN/COMMIT inside a transaction, so we use SAVEPOINTs.
    if (this.transactionDepth > 0) {
      const savepointName = `wolbarg_sp_${this.savepointCounter++}`;
      db.exec(`SAVEPOINT ${savepointName}`);
      try {
        this.transactionDepth += 1;
        const result = await fn();
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch {
          // ignore rollback-to-savepoint failures; original error is more important
        }
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.transactionDepth = 1;
    try {
      return await withImmediateTransaction(
        db,
        this.concurrency,
        fn,
        (attempt, delayMs) => {
          this.retryLog?.(
            `SQLITE_BUSY retry attempt=${attempt} backoffMs=${Math.round(delayMs)}`,
          );
        },
      );
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private tryLoadSqliteVec(db: DatabaseSync): boolean {
    // win32-arm64 (and similar) cannot load sqlite-vec — skip the failed
    // load attempt on every open (saves cold-start ms).
    const plat = `${process.platform}-${process.arch}`;
    if (SqliteStorageProvider.sqliteVecUnsupported.has(plat)) {
      return false;
    }
    try {
      sqliteVec.load(db);
      return true;
    } catch {
      SqliteStorageProvider.sqliteVecUnsupported.add(plat);
      return false;
    }
  }

  private static sqliteVecUnsupported = new Set<string>();

  private runMigrations(db: DatabaseSync): void {
    db.exec(CREATE_META_TABLE);
    db.exec(CREATE_MEMORIES_TABLE);
    db.exec(CREATE_HISTORY_TABLE);
    db.exec(CREATE_BLOB_EMBEDDINGS_TABLE);
    db.exec(CREATE_EMBEDDING_CACHE_TABLE);

    const current = this.readMetaNumberFromDb(db, META_KEYS.schemaVersion);
    if (current === null) {
      db.exec(CREATE_FTS_TABLE);
      this.backfillFts(db);
      this.migrateToV3(db);
      for (const dropSql of DROP_REDUNDANT_INDEXES_V4) {
        db.exec(dropSql);
      }
      for (const indexSql of CREATE_INDEXES) {
        db.exec(indexSql);
      }
      db.prepare(SQL.setMeta).run(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
      this.ensureFtsConsistency(db);
    } else if (current > SCHEMA_VERSION) {
      throw new InitializationError(
        `Database schema version ${current} is newer than this SDK (supports ${SCHEMA_VERSION}).`,
      );
    } else if (current < SCHEMA_VERSION) {
      if (current < 3) {
        db.exec(CREATE_FTS_TABLE);
        this.backfillFts(db);
        this.migrateToV3(db);
      }
      if (current < 4) {
        this.migrateToV4(db);
      }
      for (const indexSql of CREATE_INDEXES) {
        db.exec(indexSql);
      }
      db.prepare(SQL.setMeta).run(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
      this.ensureFtsConsistency(db);
    }
    // current === SCHEMA_VERSION: skip index churn and FTS rescans (warm-start path).
  }

  /**
   * Schema v4: drop unused global created_at index, strip archived vectors
   * from ANN, add agent-active covering index (via CREATE_INDEXES).
   */
  private migrateToV4(db: DatabaseSync): void {
    for (const dropSql of DROP_REDUNDANT_INDEXES_V4) {
      db.exec(dropSql);
    }

    // Archived memories must not remain in ANN (recall post-filter waste).
    try {
      db.prepare(SQL.deleteArchivedEmbeddings).run();
    } catch {
      // vec table may not exist yet
    }
    try {
      db.prepare(SQL.deleteArchivedEmbeddingsBlob).run();
    } catch {
      // ignore
    }
    this.memoryIndexDirty = true;
  }

  /**
   * Schema v3: content_hash column, history 'updated' event, embedding_cache.
   * SQLite cannot ALTER CHECK constraints — rebuild memory_history when needed.
   */
  private migrateToV3(db: DatabaseSync): void {
    // Add content_hash if missing
    const cols = db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as unknown as Array<{ name: string }>;
    const hasHash = cols.some((c) => c.name === "content_hash");
    if (!hasHash) {
      db.exec(`ALTER TABLE memories ADD COLUMN content_hash TEXT`);
    }

    // Backfill content_hash for active rows (newest wins on collision via unique index)
    const active = db
      .prepare(
        `SELECT id, content_text, updated_at FROM memories WHERE archived = 0 ORDER BY updated_at DESC`,
      )
      .all() as unknown as Array<{
      id: string;
      content_text: string;
      updated_at: string;
    }>;
    const seen = new Set<string>();
    const updateHash = db.prepare(
      `UPDATE memories SET content_hash = ? WHERE id = ?`,
    );
    for (const row of active) {
      const hash = hashMemoryContent(row.content_text);
      // Scope uniqueness is (org, agent, hash) — we only have id here; full
      // uniqueness is enforced after org/agent-aware backfill below.
      updateHash.run(hash, row.id);
    }

    // Re-backfill with org+agent awareness: null out older duplicates
    const activeFull = db
      .prepare(
        `SELECT id, organization, agent, content_text, updated_at
         FROM memories WHERE archived = 0
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as Array<{
      id: string;
      organization: string;
      agent: string;
      content_text: string;
      updated_at: string;
    }>;
    seen.clear();
    const clearHash = db.prepare(
      `UPDATE memories SET content_hash = NULL WHERE id = ?`,
    );
    const setHash = db.prepare(
      `UPDATE memories SET content_hash = ? WHERE id = ?`,
    );
    for (const row of activeFull) {
      const hash = hashMemoryContent(row.content_text);
      const key = `${row.organization}\0${row.agent}\0${hash}`;
      if (seen.has(key)) {
        clearHash.run(row.id);
      } else {
        seen.add(key);
        setHash.run(hash, row.id);
      }
    }

    // Rebuild history table to allow 'updated' in CHECK
    this.migrateHistoryAllowUpdated(db);
    db.exec(CREATE_EMBEDDING_CACHE_TABLE);
  }

  private migrateHistoryAllowUpdated(db: DatabaseSync): void {
    const sql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_history'`,
      )
      .get() as { sql?: string } | undefined;
    if (sql?.sql?.includes("'updated'")) {
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_history_v3 (
        id TEXT PRIMARY KEY NOT NULL,
        memory_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'archived', 'compressed', 'updated')),
        related_memory_id TEXT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      INSERT INTO memory_history_v3 (id, memory_id, event_type, related_memory_id, created_at)
        SELECT id, memory_id, event_type, related_memory_id, created_at FROM memory_history;
      DROP TABLE memory_history;
      ALTER TABLE memory_history_v3 RENAME TO memory_history;
      CREATE INDEX IF NOT EXISTS idx_history_memory_id ON memory_history(memory_id);
    `);
  }

  /**
   * Rebuild FTS from active (non-archived) memories when counts diverge.
   * Guarantees keyword/hybrid correctness after crashes or interrupted writes.
   */
  private ensureFtsConsistency(db: DatabaseSync): void {
    try {
      const memCount = db
        .prepare(`SELECT COUNT(*) AS c FROM memories WHERE archived = 0`)
        .get() as { c: number | bigint };
      const ftsCount = db
        .prepare(`SELECT COUNT(*) AS c FROM memories_fts`)
        .get() as { c: number | bigint };
      if (Number(memCount.c) !== Number(ftsCount.c)) {
        this.backfillFts(db);
      }
    } catch {
      // FTS unavailable — keyword search degrades gracefully.
    }
  }

  private backfillFts(db: DatabaseSync): void {
    try {
      db.exec(`DELETE FROM memories_fts`);
      const rows = db
        .prepare(
          `SELECT id, organization, agent, content_text FROM memories WHERE archived = 0`,
        )
        .all() as unknown as Array<{
        id: string;
        organization: string;
        agent: string;
        content_text: string;
      }>;
      const insert = db.prepare(SQL.insertFts);
      for (const row of rows) {
        insert.run(row.content_text, row.id, row.organization, row.agent);
      }
    } catch {
      // FTS may be unavailable on exotic builds — keyword search degrades.
    }
  }

  private prepareStatements(db: DatabaseSync): PreparedStatements {
    let insertFts: StatementSync | null = null;
    let deleteFts: StatementSync | null = null;
    let deleteFtsByOrg: StatementSync | null = null;
    let deleteFtsByOrgAgent: StatementSync | null = null;
    let searchFts: StatementSync | null = null;
    try {
      insertFts = db.prepare(SQL.insertFts);
      deleteFts = db.prepare(SQL.deleteFts);
      deleteFtsByOrg = db.prepare(SQL.deleteFtsByOrg);
      deleteFtsByOrgAgent = db.prepare(SQL.deleteFtsByOrgAgent);
      searchFts = db.prepare(SQL.searchFts);
    } catch {
      // FTS optional
    }

    let deleteEmbeddingsByOrg: StatementSync | null = null;
    let deleteEmbeddingsByOrgAgent: StatementSync | null = null;
    let deleteEmbeddingsBlobByOrg: StatementSync | null = null;
    let deleteEmbeddingsBlobByOrgAgent: StatementSync | null = null;
    try {
      deleteEmbeddingsByOrg = db.prepare(SQL.deleteEmbeddingsByOrg);
      deleteEmbeddingsByOrgAgent = db.prepare(SQL.deleteEmbeddingsByOrgAgent);
    } catch {
      // vec table may not exist yet
    }
    try {
      deleteEmbeddingsBlobByOrg = db.prepare(SQL.deleteEmbeddingsBlobByOrg);
      deleteEmbeddingsBlobByOrgAgent = db.prepare(
        SQL.deleteEmbeddingsBlobByOrgAgent,
      );
    } catch {
      // ignore
    }

    return {
      getMeta: db.prepare(SQL.getMeta),
      setMeta: db.prepare(SQL.setMeta),
      insertMemory: db.prepare(SQL.insertMemory),
      updateMemoryContent: db.prepare(SQL.updateMemoryContent),
      getMemoryById: db.prepare(SQL.getMemoryById),
      getMemoryByRowid: db.prepare(SQL.getMemoryByRowid),
      findActiveByContentHash: db.prepare(SQL.findActiveByContentHash),
      insertEmbedding: null,
      deleteEmbedding: null,
      searchVectors: null,
      insertEmbeddingBlob: null,
      deleteEmbeddingBlob: null,
      listEmbeddingsBlob: null,
      archiveMemory: db.prepare(SQL.archiveMemory),
      deleteMemoryById: db.prepare(SQL.deleteMemoryById),
      deleteMemoriesByOrg: db.prepare(SQL.deleteMemoriesByOrg),
      deleteMemoriesByOrgAgent: db.prepare(SQL.deleteMemoriesByOrgAgent),
      insertHistory: db.prepare(SQL.insertHistory),
      getHistory: db.prepare(SQL.getHistory),
      getStats: db.prepare(SQL.getStats),
      listRowidsForOrg: db.prepare(SQL.listRowidsForOrg),
      listRowidsForOrgAgent: db.prepare(SQL.listRowidsForOrgAgent),
      vectorTableExists: db.prepare(SQL.vectorTableExists),
      blobTableExists: db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings_blob'`,
      ),
      insertFts,
      deleteFts,
      deleteFtsByOrg,
      deleteFtsByOrgAgent,
      searchFts,
      deleteEmbeddingsByOrg,
      deleteEmbeddingsByOrgAgent,
      deleteEmbeddingsBlobByOrg,
      deleteEmbeddingsBlobByOrgAgent,
    };
  }

  private listMemoriesIndexed(
    filter: RepositoryFilter,
    limit?: number,
  ): MemoryRow[] {
    const clauses: string[] = [`organization = ?`];
    const params: Array<string | number> = [filter.organization];
    if (filter.agent) {
      clauses.push(`agent = ?`);
      params.push(filter.agent);
    }
    if (!filter.includeArchived) {
      clauses.push(`archived = 0`);
    }
    const key = `${filter.agent ? "a" : "_"}:${filter.includeArchived ? "A" : "0"}:${limit !== undefined ? "L" : "_"}`;
    let stmt = this.listStatements.get(key);
    if (!stmt) {
      let sql = `
        SELECT rowid, id, organization, agent, content_text, metadata_json,
               archived, compressed_into, content_hash, created_at, updated_at
        FROM memories
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC
      `;
      if (limit !== undefined) {
        sql += ` LIMIT ?`;
      }
      stmt = this.requireDb().prepare(sql);
      this.listStatements.set(key, stmt);
    }
    if (limit !== undefined) {
      return stmt.all(...params, limit) as unknown as MemoryRow[];
    }
    return stmt.all(...params) as unknown as MemoryRow[];
  }

  /**
   * Metadata-filtered list: push filters to json_extract when possible;
   * otherwise page with a hard scan cap (never load unbounded orgs into RAM).
   */
  private listMemoriesWithMetadata(
    filter: RepositoryFilter,
    limit?: number,
  ): MemoryRow[] {
    const want = limit ?? MAX_METADATA_SCAN;
    const compiled = filter.metadata
      ? compileMetadataFilterToSql(filter.metadata)
      : null;

    if (compiled) {
      const clauses: string[] = [`organization = ?`, `(${compiled.expression})`];
      const params: unknown[] = [filter.organization, ...compiled.params];
      if (filter.agent) {
        clauses.push(`agent = ?`);
        params.push(filter.agent);
      }
      if (!filter.includeArchived) {
        clauses.push(`archived = 0`);
      }
      const sql = `
        SELECT rowid, id, organization, agent, content_text, metadata_json,
               archived, compressed_into, content_hash, created_at, updated_at
        FROM memories
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC
        LIMIT ?
      `;
      params.push(want);
      return this.requireDb()
        .prepare(sql)
        .all(...(params as never[])) as unknown as MemoryRow[];
    }

    // Fallback: paged JS filter with hard scan ceiling.
    const matched: MemoryRow[] = [];
    let offset = 0;
    const db = this.requireDb();
    const clauses: string[] = [`organization = ?`];
    const baseParams: Array<string | number> = [filter.organization];
    if (filter.agent) {
      clauses.push(`agent = ?`);
      baseParams.push(filter.agent);
    }
    if (!filter.includeArchived) {
      clauses.push(`archived = 0`);
    }
    const pageSql = `
      SELECT rowid, id, organization, agent, content_text, metadata_json,
             archived, compressed_into, content_hash, created_at, updated_at
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `;
    const pageStmt = db.prepare(pageSql);
    while (matched.length < want && offset < MAX_METADATA_SCAN) {
      const pageLimit = Math.min(METADATA_PAGE_SIZE, MAX_METADATA_SCAN - offset);
      const page = pageStmt.all(
        ...baseParams,
        pageLimit,
        offset,
      ) as unknown as MemoryRow[];
      if (page.length === 0) {
        break;
      }
      for (const row of page) {
        if (
          matchesMetadata(
            deserializeMetadata(row.metadata_json),
            filter.metadata!,
          )
        ) {
          matched.push(row);
          if (matched.length >= want) {
            return matched;
          }
        }
      }
      offset += page.length;
      if (page.length < pageLimit) {
        break;
      }
    }
    return matched;
  }

  private getRowidInStatement(count: number): StatementSync {
    let stmt = this.rowidInStatements.get(count);
    if (!stmt) {
      const placeholders = Array.from({ length: count }, () => "?").join(",");
      const sql = `${SQL.getMemoriesByRowidsPrefix}${placeholders})`;
      stmt = this.requireDb().prepare(sql);
      this.rowidInStatements.set(count, stmt);
    }
    return stmt;
  }

  private insertMemoryChunk(inputs: InsertMemoryInput[]): MemoryRow[] {
    const stmts = this.requireStatements();
    const n = inputs.length;
    if (n === 1) {
      const input = inputs[0]!;
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : hashMemoryContent(input.contentText);
      const row = stmts.insertMemory.get(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        contentHash,
        input.createdAt,
        input.updatedAt,
      ) as unknown as MemoryRow | undefined;
      if (!row || row.rowid === undefined) {
        throw new DatabaseError("Failed to read memory after batch insert");
      }
      this.insertEmbedding(row.rowid, input.embedding);
      this.insertFtsRow(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
      );
      stmts.insertHistory.run(
        crypto.randomUUID(),
        input.id,
        "created",
        null,
        input.createdAt,
      );
      return [row];
    }

    let stmt = this.batchInsertStatements.get(n);
    if (!stmt) {
      const valueRow =
        "(?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)";
      const values = Array.from({ length: n }, () => valueRow).join(", ");
      const sql = `
        INSERT INTO memories (
          id, organization, agent, content_text, metadata_json,
          archived, compressed_into, content_hash, created_at, updated_at
        ) VALUES ${values}
        RETURNING rowid, id, organization, agent, content_text, metadata_json,
                  archived, compressed_into, content_hash, created_at, updated_at
      `;
      stmt = this.requireDb().prepare(sql);
      this.batchInsertStatements.set(n, stmt);
    }

    const binds: unknown[] = [];
    for (const input of inputs) {
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : hashMemoryContent(input.contentText);
      binds.push(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
        contentHash,
        input.createdAt,
        input.updatedAt,
      );
    }

    const rows = stmt.all(...(binds as never[])) as unknown as MemoryRow[];
    if (rows.length !== n) {
      throw new DatabaseError("Failed to read memories after batch insert");
    }
    for (const row of rows) {
      if (row.rowid === undefined) {
        throw new DatabaseError("Failed to read memory rowid after batch insert");
      }
    }

    // Multi-row side tables — one statement each instead of 3N run() calls.
    this.insertEmbeddingsBatch(rows, inputs);
    this.insertFtsBatch(inputs);
    this.insertHistoryBatch(inputs);
    return rows;
  }

  private insertEmbeddingsBatch(
    rows: MemoryRow[],
    inputs: InsertMemoryInput[],
  ): void {
    const n = rows.length;
    if (this.vectorBackend === "sqlite-vec") {
      for (let i = 0; i < n; i += 1) {
        this.insertEmbedding(rows[i]!.rowid!, inputs[i]!.embedding);
      }
      return;
    }
    // Blob backend: multi-value INSERT + incremental in-memory index upsert.
    let stmt = this.batchBlobEmbStatements.get(n);
    if (!stmt) {
      const values = Array.from({ length: n }, () => "(?, ?)").join(", ");
      stmt = this.requireDb().prepare(
        `INSERT OR REPLACE INTO memory_embeddings_blob (memory_rowid, embedding) VALUES ${values}`,
      );
      this.batchBlobEmbStatements.set(n, stmt);
    }
    const binds: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      binds.push(rows[i]!.rowid!, embeddingToBuffer(inputs[i]!.embedding));
    }
    stmt.run(...(binds as never[]));
    if (this.memoryIndex && this.vectorDimensions !== null) {
      for (let i = 0; i < n; i += 1) {
        this.memoryIndex.upsert(rows[i]!.rowid!, inputs[i]!.embedding);
      }
      this.memoryIndexDirty = false;
    } else {
      this.memoryIndexDirty = true;
    }
  }

  private insertFtsBatch(inputs: InsertMemoryInput[]): void {
    const stmts = this.requireStatements();
    if (!stmts.insertFts) {
      return;
    }
    const n = inputs.length;
    let stmt = this.batchFtsStatements.get(n);
    if (!stmt) {
      const values = Array.from({ length: n }, () => "(?, ?, ?, ?)").join(", ");
      stmt = this.requireDb().prepare(
        `INSERT INTO memories_fts (content_text, memory_id, organization, agent) VALUES ${values}`,
      );
      this.batchFtsStatements.set(n, stmt);
    }
    const binds: unknown[] = [];
    for (const input of inputs) {
      binds.push(
        input.contentText,
        input.id,
        input.organization,
        input.agent,
      );
    }
    try {
      stmt.run(...(binds as never[]));
    } catch {
      // Fall back to per-row if FTS shape differs.
      for (const input of inputs) {
        this.insertFtsRow(
          input.id,
          input.organization,
          input.agent,
          input.contentText,
        );
      }
    }
  }

  private insertHistoryBatch(inputs: InsertMemoryInput[]): void {
    const n = inputs.length;
    let stmt = this.batchHistoryStatements.get(n);
    if (!stmt) {
      const values = Array.from({ length: n }, () => "(?, ?, ?, ?, ?)").join(
        ", ",
      );
      stmt = this.requireDb().prepare(
        `INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
         VALUES ${values}`,
      );
      this.batchHistoryStatements.set(n, stmt);
    }
    const binds: unknown[] = [];
    for (const input of inputs) {
      binds.push(
        crypto.randomUUID(),
        input.id,
        "created",
        null,
        input.createdAt,
      );
    }
    stmt.run(...(binds as never[]));
  }

  private deleteEmbeddingsForScope(
    organization: string,
    agent?: string,
  ): void {
    const stmts = this.requireStatements();
    try {
      if (this.vectorBackend === "sqlite-vec") {
        if (agent) {
          stmts.deleteEmbeddingsByOrgAgent?.run(organization, agent);
        } else {
          stmts.deleteEmbeddingsByOrg?.run(organization);
        }
      } else {
        if (agent) {
          stmts.deleteEmbeddingsBlobByOrgAgent?.run(organization, agent);
        } else {
          stmts.deleteEmbeddingsBlobByOrg?.run(organization);
        }
        this.memoryIndexDirty = true;
        if (!agent) {
          this.memoryIndex?.clear();
        }
      }
    } catch {
      // Vector table may not exist yet on a fresh DB.
    }
  }

  private deleteFtsForScope(organization: string, agent?: string): void {
    const stmts = this.requireStatements();
    try {
      if (agent) {
        stmts.deleteFtsByOrgAgent?.run(organization, agent);
      } else {
        stmts.deleteFtsByOrg?.run(organization);
      }
    } catch {
      // FTS optional
    }
  }

  /** Insert-only FTS row (new memory IDs never collide). */
  private insertFtsRow(
    memoryId: string,
    organization: string,
    agent: string,
    contentText: string,
  ): void {
    const stmts = this.requireStatements();
    if (!stmts.insertFts) {
      return;
    }
    try {
      stmts.insertFts.run(contentText, memoryId, organization, agent);
    } catch {
      // ignore FTS errors — keyword search degrades but semantic search remains
    }
  }

  private upsertFts(
    memoryId: string,
    organization: string,
    agent: string,
    contentText: string,
  ): void {
    const stmts = this.requireStatements();
    if (!stmts.insertFts || !stmts.deleteFts) {
      return;
    }
    try {
      stmts.deleteFts.run(memoryId);
      stmts.insertFts.run(contentText, memoryId, organization, agent);
    } catch {
      // ignore FTS errors — keyword search degrades but semantic search remains
    }
  }

  private deleteFts(memoryId: string): void {
    const stmts = this.requireStatements();
    if (!stmts.deleteFts) {
      return;
    }
    try {
      stmts.deleteFts.run(memoryId);
    } catch {
      // ignore
    }
  }

  private ensureVectorStorage(dimensions: number): void {
    const db = this.requireDb();
    if (this.vectorBackend === "sqlite-vec") {
      if (!this.sqliteVecLoaded) {
        throw new InitializationError(
          "sqlite-vec is required for this database but is unavailable on this platform.",
        );
      }
      const stmts = this.requireStatements();
      const exists = stmts.vectorTableExists.get() as { name: string } | undefined;
      if (!exists) {
        db.exec(buildVectorTableSql(dimensions));
      }
      this.memoryIndex = null;
      return;
    }

    db.exec(CREATE_BLOB_EMBEDDINGS_TABLE);
    if (!this.memoryIndex || this.memoryIndex.size === 0) {
      this.memoryIndex = new InMemoryVectorIndex(dimensions);
    }
  }

  private hydrateMemoryIndex(): void {
    if (this.vectorBackend !== "blob" || this.vectorDimensions === null) {
      this.memoryIndex = null;
      return;
    }
    const stmts = this.requireStatements();
    if (!stmts.listEmbeddingsBlob) {
      stmts.listEmbeddingsBlob = this.requireDb().prepare(SQL.listEmbeddingsBlob);
    }
    const index = new InMemoryVectorIndex(this.vectorDimensions);
    try {
      const rows = stmts.listEmbeddingsBlob.all() as unknown as Array<{
        memory_rowid: number;
        embedding: Uint8Array | Buffer;
      }>;
      for (const row of rows) {
        index.upsert(row.memory_rowid, bufferToEmbedding(row.embedding));
      }
    } catch {
      // empty table is fine
    }
    this.memoryIndex = index;
  }

  private reprepareVectorStatements(): void {
    const db = this.requireDb();
    const stmts = this.requireStatements();

    if (this.vectorBackend === "sqlite-vec") {
      stmts.insertEmbedding = db.prepare(SQL.insertEmbedding);
      stmts.deleteEmbedding = db.prepare(SQL.deleteEmbedding);
      stmts.searchVectors = db.prepare(SQL.searchVectors);
      stmts.insertEmbeddingBlob = null;
      stmts.deleteEmbeddingBlob = null;
      stmts.listEmbeddingsBlob = null;
      try {
        stmts.deleteEmbeddingsByOrg = db.prepare(SQL.deleteEmbeddingsByOrg);
        stmts.deleteEmbeddingsByOrgAgent = db.prepare(
          SQL.deleteEmbeddingsByOrgAgent,
        );
      } catch {
        // ignore
      }
      return;
    }

    stmts.insertEmbeddingBlob = db.prepare(SQL.insertEmbeddingBlob);
    stmts.deleteEmbeddingBlob = db.prepare(SQL.deleteEmbeddingBlob);
    stmts.listEmbeddingsBlob = db.prepare(SQL.listEmbeddingsBlob);
    stmts.insertEmbedding = null;
    stmts.deleteEmbedding = null;
    stmts.searchVectors = null;
    try {
      stmts.deleteEmbeddingsBlobByOrg = db.prepare(SQL.deleteEmbeddingsBlobByOrg);
      stmts.deleteEmbeddingsBlobByOrgAgent = db.prepare(
        SQL.deleteEmbeddingsBlobByOrgAgent,
      );
    } catch {
      // ignore
    }
  }

  private insertEmbedding(rowid: number | bigint, embedding: Float32Array): void {
    const stmts = this.requireStatements();
    if (this.vectorBackend === "sqlite-vec") {
      // node:sqlite + sqlite-vec require BigInt for vec0 integer PKs (esp. Linux).
      stmts.insertEmbedding!.run(this.toVecRowid(rowid), this.toVectorParam(embedding));
      return;
    }
    const id = Number(rowid);
    stmts.insertEmbeddingBlob!.run(id, embeddingToBuffer(embedding));
    // Keep the hot in-memory ANN index incremental — avoid O(n) rebuilds.
    if (this.memoryIndex) {
      this.memoryIndex.upsert(id, embedding);
      this.memoryIndexDirty = false;
    } else {
      this.memoryIndexDirty = true;
    }
  }

  private deleteEmbedding(rowid: number | bigint): void {
    const stmts = this.requireStatements();
    try {
      if (this.vectorBackend === "sqlite-vec" && stmts.deleteEmbedding) {
        stmts.deleteEmbedding.run(this.toVecRowid(rowid));
      } else if (stmts.deleteEmbeddingBlob) {
        const id = Number(rowid);
        stmts.deleteEmbeddingBlob.run(id);
        this.memoryIndex?.remove(id);
        this.memoryIndexDirty = true;
      }
    } catch {
      // Ignore missing vectors during delete.
    }
  }

  private searchWithSqliteVec(
    embedding: Float32Array,
    topK: number,
  ): VectorSearchHit[] {
    const stmts = this.requireStatements();
    try {
      const rows = stmts.searchVectors!.all(
        this.toVectorParam(embedding),
        topK,
      ) as unknown as Array<{ memory_rowid: number; distance: number }>;

      const hits: VectorSearchHit[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        hits[i] = {
          memoryRowid: Number(row.memory_rowid),
          distance: Number(row.distance),
        };
      }
      return hits;
    } catch (error) {
      throw new DatabaseError(`Vector search failed: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private searchWithBlobFallback(
    embedding: Float32Array,
    topK: number,
  ): VectorSearchHit[] {
    if (this.memoryIndexDirty || !this.memoryIndex) {
      this.hydrateMemoryIndex();
      this.memoryIndexDirty = false;
    }
    if (this.memoryIndex && this.vectorDimensions !== null) {
      const query = normalizeEmbedding(embedding, this.vectorDimensions);
      return this.memoryIndex.search(query, topK);
    }
    throw new DatabaseError("Blob vector index is not initialized");
  }

  private async setMeta(key: string, value: string): Promise<void> {
    const stmts = this.requireStatements();
    stmts.setMeta.run(key, value);
  }

  private readMetaNumber(key: string): number | null {
    const stmts = this.requireStatements();
    const row = stmts.getMeta.get(key) as { value: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private readMetaString(key: string): string | null {
    const stmts = this.requireStatements();
    const row = stmts.getMeta.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private readMetaNumberFromDb(db: DatabaseSync, key: string): number | null {
    const row = db.prepare(SQL.getMeta).get(key) as { value: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private resolvePath(connectionString: string): string {
    if (connectionString === ":memory:") {
      return ":memory:";
    }
    return path.isAbsolute(connectionString)
      ? connectionString
      : path.resolve(process.cwd(), connectionString);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new DatabaseError("Database is not open. Call init() first.");
    }
    return this.db;
  }

  private requireStatements(): PreparedStatements {
    if (!this.statements) {
      throw new DatabaseError("Database statements are not prepared. Call init() first.");
    }
    return this.statements;
  }

  private requireVectorReady(): void {
    if (!this.vectorBackend || this.vectorDimensions === null) {
      throw new DatabaseError(
        "Vector index is not ready. Embedding dimensions have not been initialized.",
      );
    }
  }

  private toVectorParam(embedding: Float32Array): Uint8Array {
    const buffer = embeddingToBuffer(embedding);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  /** sqlite-vec vec0 PKs must be bound as BigInt under node:sqlite. */
  private toVecRowid(rowid: number | bigint): bigint {
    return typeof rowid === "bigint" ? rowid : BigInt(rowid);
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/** @deprecated Prefer {@link SqliteStorageProvider}. */
export const SqliteDatabaseProvider = SqliteStorageProvider;

/** Turn free text into a safe FTS5 MATCH query (OR of terms). */
function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) {
    return "";
  }
  return terms.map((t) => `"${t}"`).join(" OR ");
}
