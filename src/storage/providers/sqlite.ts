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
import {
  CREATE_BLOB_EMBEDDINGS_TABLE,
  CREATE_FTS_TABLE,
  CREATE_HISTORY_TABLE,
  CREATE_INDEXES,
  CREATE_MEMORIES_TABLE,
  CREATE_META_TABLE,
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

interface PreparedStatements {
  getMeta: StatementSync;
  setMeta: StatementSync;
  insertMemory: StatementSync;
  updateMemoryContent: StatementSync;
  getMemoryById: StatementSync;
  getMemoryByRowid: StatementSync;
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
  countMemories: StatementSync;
  countActiveMemories: StatementSync;
  countArchivedMemories: StatementSync;
  countAgents: StatementSync;
  listRowidsForOrg: StatementSync;
  listRowidsForOrgAgent: StatementSync;
  vectorTableExists: StatementSync;
  blobTableExists: StatementSync;
  insertFts: StatementSync | null;
  deleteFts: StatementSync | null;
  searchFts: StatementSync | null;
}

export interface SqliteProviderOptions {
  connectionString: string;
}

export class SqliteStorageProvider implements StorageProvider {
  readonly name = "sqlite";

  private readonly connectionString: string;
  private db: DatabaseSync | null = null;
  private statements: PreparedStatements | null = null;
  private vectorDimensions: number | null = null;
  private vectorBackend: VectorBackend | null = null;
  private sqliteVecLoaded = false;
  /** Hot in-process ANN for blob backend (sqlite-vec unavailable platforms). */
  private memoryIndex: InMemoryVectorIndex | null = null;
  private memoryIndexDirty = false;
  /** Resolved absolute path (or `:memory:`) — avoid re-resolving on size checks. */
  private resolvedPath: string | null = null;

  constructor(options: SqliteProviderOptions) {
    this.connectionString = options.connectionString;
  }

  /** Absolute or relative path / `:memory:` used by this provider. */
  get path(): string {
    return this.connectionString;
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
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -65536;
        PRAGMA mmap_size = 268435456;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA recursive_triggers = OFF;
      `);

      this.sqliteVecLoaded = this.tryLoadSqliteVec(db);
      this.runMigrations(db);
      this.statements = this.prepareStatements(db);
      this.ensureFtsConsistency(db);

      const backend = this.readMetaString(META_KEYS.vectorBackend) as VectorBackend | null;
      const dims = this.readMetaNumber(META_KEYS.embeddingDimensions);

      if (backend) {
        this.vectorBackend = backend;
      } else if (this.sqliteVecLoaded) {
        this.vectorBackend = "sqlite-vec";
      } else {
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
    if (!this.db) {
      return;
    }
    try {
      this.db.close();
    } catch (error) {
      throw new DatabaseError(`Failed to close database: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      this.db = null;
      this.statements = null;
      this.memoryIndex = null;
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
    const stmts = this.requireStatements();
    this.requireVectorReady();

    return this.withTransaction(() => {
      const row = stmts.insertMemory.get(
        input.id,
        input.organization,
        input.agent,
        input.contentText,
        serializeMetadata(input.metadata),
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
    const stmts = this.requireStatements();
    this.requireVectorReady();

    return this.withTransaction(() => {
      const rows: MemoryRow[] = [];
      for (const input of inputs) {
        const row = stmts.insertMemory.get(
          input.id,
          input.organization,
          input.agent,
          input.contentText,
          serializeMetadata(input.metadata),
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
        rows.push(row);
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

      stmts.updateMemoryContent.run(
        input.contentText ?? null,
        input.metadata !== undefined ? metadataJson : null,
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

      return stmts.getMemoryById.get(input.id, input.organization) as unknown as MemoryRow;
    });
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
    } catch {
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
    const db = this.requireDb();
    // Chunk IN lists to stay well under SQLite variable limits.
    const chunkSize = 400;
    for (let offset = 0; offset < rowids.length; offset += chunkSize) {
      const chunk = rowids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const sql = `${SQL.getMemoriesByRowidsPrefix}${placeholders})`;
      const rows = db.prepare(sql).all(organization, ...chunk) as unknown as MemoryRow[];
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
    const db = this.requireDb();
    const clauses: string[] = [`organization = ?`];
    const params: Array<string | number> = [filter.organization];

    if (filter.agent) {
      clauses.push(`agent = ?`);
      params.push(filter.agent);
    }
    if (!filter.includeArchived) {
      clauses.push(`archived = 0`);
    }

    let sql = `
      SELECT rowid, id, organization, agent, content_text, metadata_json,
             archived, compressed_into, created_at, updated_at
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
    `;
    if (limit !== undefined && !filter.metadata) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    try {
      let rows = db.prepare(sql).all(...params) as unknown as MemoryRow[];
      if (filter.metadata) {
        rows = rows.filter((row) =>
          matchesMetadata(
            deserializeMetadata(row.metadata_json),
            filter.metadata!,
          ),
        );
        if (limit !== undefined) {
          rows = rows.slice(0, limit);
        }
      }
      return rows;
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
   * Org-scoped KNN + memory rows.
   * Caller (Wolbarg.recall) already passes an overfetched topK — do not multiply again.
   */
  async searchVectorsWithMemories(
    embedding: Float32Array,
    topK: number,
    organization: string,
    options?: { agent?: string; includeArchived?: boolean },
  ): Promise<Array<{ row: MemoryRow; distance: number }>> {
    this.requireVectorReady();
    const hits = await this.searchVectors(embedding, topK);
    if (hits.length === 0) {
      return [];
    }
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
        const result = stmts.archiveMemory.run(
          compressedIntoId,
          archivedAt,
          id,
          organization,
        );
        if (Number(result.changes) > 0) {
          archived.push(id);
          // Drop archived rows from FTS so keyword/hybrid never return them.
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
      const listed = this.listMemoriesSync({
        organization: filter.organization,
        agent,
        includeArchived: true,
      });
      for (const memory of listed) {
        if (memory.rowid !== undefined) {
          this.deleteEmbedding(memory.rowid);
        }
        this.deleteFts(memory.id);
      }
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
      const listed = this.listMemoriesSync({ organization, includeArchived: true });
      for (const memory of listed) {
        if (memory.rowid !== undefined) {
          this.deleteEmbedding(memory.rowid);
        }
        this.deleteFts(memory.id);
      }
      const result = stmts.deleteMemoriesByOrg.run(organization);
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
    const memories = stmts.countMemories.get(organization) as unknown as {
      count: number | bigint;
    };
    const active = stmts.countActiveMemories.get(organization) as unknown as {
      count: number | bigint;
    };
    const archived = stmts.countArchivedMemories.get(organization) as unknown as {
      count: number | bigint;
    };
    const agents = stmts.countAgents.get(organization) as unknown as {
      count: number | bigint;
    };
    return {
      totalMemories: Number(memories.count),
      activeMemories: Number(active.count),
      archivedMemories: Number(archived.count),
      totalAgents: Number(agents.count),
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

  withTransaction<T>(fn: () => T): T {
    const db = this.requireDb();
    // DEFERRED is enough in single-threaded Node; IMMEDIATE adds lock latency.
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      if (
        error instanceof DatabaseError ||
        error instanceof InitializationError
      ) {
        throw error;
      }
      throw new DatabaseError(`Transaction failed: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private tryLoadSqliteVec(db: DatabaseSync): boolean {
    try {
      sqliteVec.load(db);
      return true;
    } catch {
      return false;
    }
  }

  private runMigrations(db: DatabaseSync): void {
    db.exec(CREATE_META_TABLE);
    db.exec(CREATE_MEMORIES_TABLE);
    db.exec(CREATE_HISTORY_TABLE);
    db.exec(CREATE_BLOB_EMBEDDINGS_TABLE);
    for (const indexSql of CREATE_INDEXES) {
      db.exec(indexSql);
    }

    const current = this.readMetaNumberFromDb(db, META_KEYS.schemaVersion);
    if (current === null) {
      db.exec(CREATE_FTS_TABLE);
      this.backfillFts(db);
      db.prepare(SQL.setMeta).run(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
    } else if (current > SCHEMA_VERSION) {
      throw new InitializationError(
        `Database schema version ${current} is newer than this SDK (supports ${SCHEMA_VERSION}).`,
      );
    } else if (current < SCHEMA_VERSION) {
      db.exec(CREATE_FTS_TABLE);
      this.backfillFts(db);
      db.prepare(SQL.setMeta).run(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
    } else {
      db.exec(CREATE_FTS_TABLE);
    }
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
    let searchFts: StatementSync | null = null;
    try {
      insertFts = db.prepare(SQL.insertFts);
      deleteFts = db.prepare(SQL.deleteFts);
      searchFts = db.prepare(SQL.searchFts);
    } catch {
      // FTS optional
    }

    return {
      getMeta: db.prepare(SQL.getMeta),
      setMeta: db.prepare(SQL.setMeta),
      insertMemory: db.prepare(SQL.insertMemory),
      updateMemoryContent: db.prepare(SQL.updateMemoryContent),
      getMemoryById: db.prepare(SQL.getMemoryById),
      getMemoryByRowid: db.prepare(SQL.getMemoryByRowid),
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
      countMemories: db.prepare(SQL.countMemories),
      countActiveMemories: db.prepare(SQL.countActiveMemories),
      countArchivedMemories: db.prepare(SQL.countArchivedMemories),
      countAgents: db.prepare(SQL.countAgents),
      listRowidsForOrg: db.prepare(SQL.listRowidsForOrg),
      listRowidsForOrgAgent: db.prepare(SQL.listRowidsForOrgAgent),
      vectorTableExists: db.prepare(SQL.vectorTableExists),
      blobTableExists: db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings_blob'`,
      ),
      insertFts,
      deleteFts,
      searchFts,
    };
  }

  private listMemoriesSync(filter: RepositoryFilter): MemoryRow[] {
    const db = this.requireDb();
    const clauses: string[] = [`organization = ?`];
    const params: Array<string | number> = [filter.organization];
    if (filter.agent) {
      clauses.push(`agent = ?`);
      params.push(filter.agent);
    }
    if (!filter.includeArchived) {
      clauses.push(`archived = 0`);
    }
    const sql = `
      SELECT rowid, id, organization, agent, content_text, metadata_json,
             archived, compressed_into, created_at, updated_at
      FROM memories
      WHERE ${clauses.join(" AND ")}
    `;
    return db.prepare(sql).all(...params) as unknown as MemoryRow[];
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
      return;
    }

    stmts.insertEmbeddingBlob = db.prepare(SQL.insertEmbeddingBlob);
    stmts.deleteEmbeddingBlob = db.prepare(SQL.deleteEmbeddingBlob);
    stmts.listEmbeddingsBlob = db.prepare(SQL.listEmbeddingsBlob);
    stmts.insertEmbedding = null;
    stmts.deleteEmbedding = null;
    stmts.searchVectors = null;
  }

  private insertEmbedding(rowid: number, embedding: Float32Array): void {
    const stmts = this.requireStatements();
    if (this.vectorBackend === "sqlite-vec") {
      stmts.insertEmbedding!.run(rowid, this.toVectorParam(embedding));
      return;
    }
    stmts.insertEmbeddingBlob!.run(rowid, embeddingToBuffer(embedding));
    // Defer in-memory index rebuild until the next search (faster writes).
    this.memoryIndexDirty = true;
  }

  private deleteEmbedding(rowid: number): void {
    const stmts = this.requireStatements();
    try {
      if (this.vectorBackend === "sqlite-vec" && stmts.deleteEmbedding) {
        stmts.deleteEmbedding.run(rowid);
      } else if (stmts.deleteEmbeddingBlob) {
        stmts.deleteEmbeddingBlob.run(rowid);
        this.memoryIndex?.remove(rowid);
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
          memoryRowid: row.memory_rowid,
          distance: row.distance,
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
