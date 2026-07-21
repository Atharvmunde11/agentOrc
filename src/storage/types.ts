/**
 * Shared provider contracts for Wolbarg storage layer.
 *
 * {@link StorageProvider} is the low-level contract implemented by SQLite and
 * PostgreSQL backends. Custom storage engines must implement every required method;
 * optional methods enable performance optimizations (batch fetch, native keyword search).
 */

import type { MemoryMetadata } from "../types/index.js";
import type { MetadataFilter } from "../filters/types.js";

/** Row shape returned from the `memories` table. */
export interface MemoryRow {
  /** Memory UUID primary key. */
  id: string;
  /** Organization namespace. */
  organization: string;
  /** Owning agent id. */
  agent: string;
  /** Plain-text memory body. */
  content_text: string;
  /** Serialized JSON metadata. */
  metadata_json: string;
  /** `1` when soft-archived, `0` when active. */
  archived: number;
  /** Summary memory id when archived via compression, else `null`. */
  compressed_into: string | null;
  /** SHA-256 of normalized content for exact dedupe, when present. */
  content_hash?: string | null;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last update timestamp. */
  updated_at: string;
  /** SQLite integer rowid used by vec0 / vector index (when applicable). */
  rowid?: number;
}

/** Row shape for memory history events. */
export interface HistoryRow {
  id: string;
  memory_id: string;
  event_type: "created" | "archived" | "compressed" | "updated";
  related_memory_id: string | null;
  created_at: string;
}

/** Payload for inserting a new memory. */
export interface InsertMemoryInput {
  id: string;
  organization: string;
  agent: string;
  contentText: string;
  metadata: MemoryMetadata;
  embedding: Float32Array;
  createdAt: string;
  updatedAt: string;
  contentHash?: string | null;
}

/** Payload for updating memory content / metadata. */
export interface UpdateMemoryInput {
  id: string;
  organization: string;
  contentText?: string;
  metadata?: MemoryMetadata;
  embedding?: Float32Array;
  updatedAt: string;
  contentHash?: string | null;
}

/** Filters used by repository queries. */
export interface RepositoryFilter {
  organization: string;
  agent?: string;
  includeArchived?: boolean;
  metadata?: MetadataFilter;
}

/** Semantic search hit from the vector index. */
export interface VectorSearchHit {
  memoryRowid: number;
  distance: number;
}

/**
 * Low-level storage provider contract.
 *
 * Public Wolbarg API never depends on a specific engine — implement this interface
 * to add a custom backend (e.g. another SQL dialect or hosted vector store wrapper).
 *
 * @example Implementing a custom provider
 * ```ts
 * class MyStorage implements StorageProvider {
 *   readonly name = "my-storage";
 *   async open() { /* connect + migrate *\/ }
 *   async close() { /* disconnect *\/ }
 *   // ... implement remaining required methods
 * }
 * ```
 */
export interface StorageProvider {
  /** Backend identifier (e.g. `"sqlite"`, `"postgres"`). */
  readonly name: string;

  /** Open connection, enable WAL / pragmas, run migrations, prepare statements. */
  open(): Promise<void>;

  /** Close the underlying connection pool or file handle. */
  close(): Promise<void>;

  /**
   * Ensure the vector table exists for the given embedding dimensionality.
   * @param dimensions - Embedding vector length from the configured model.
   */
  ensureVectorSchema(dimensions: number): Promise<void>;

  /** @returns Stored embedding dimensions from meta table, or `null` if unset. */
  getEmbeddingDimensions(): Promise<number | null>;

  /**
   * Persist embedding dimensionality in the meta table.
   * @param dimensions - Vector length to record.
   */
  setEmbeddingDimensions(dimensions: number): Promise<void>;

  /**
   * Insert a memory + embedding inside a single ACID transaction.
   * @param input - Full insert payload including embedding vector.
   * @returns Inserted row including generated `rowid` when applicable.
   */
  insertMemory(input: InsertMemoryInput): Promise<MemoryRow>;

  /**
   * Batch insert memories + embeddings in one transaction.
   * @param inputs - Non-empty array of insert payloads.
   */
  insertMemoriesBatch(inputs: InsertMemoryInput[]): Promise<MemoryRow[]>;

  /**
   * Update memory fields and optionally replace embedding.
   * @param input - Fields to patch; omitted fields are left unchanged.
   * @returns Updated row, or `null` when id not found.
   */
  updateMemory(input: UpdateMemoryInput): Promise<MemoryRow | null>;

  /**
   * Find an active (non-archived) memory by content hash within org+agent.
   * Used by write-time exact dedupe. Optional — omit when dedupe is disabled.
   *
   * @param organization - Organization namespace.
   * @param agent - Agent id scope.
   * @param contentHash - SHA-256 from {@link hashMemoryContent}.
   */
  findActiveByContentHash?(
    organization: string,
    agent: string,
    contentHash: string,
  ): Promise<MemoryRow | null>;

  /**
   * Fetch a memory by UUID.
   * @param id - Memory id.
   * @param organization - Organization namespace (authorization scope).
   */
  getMemoryById(id: string, organization: string): Promise<MemoryRow | null>;

  /**
   * Fetch a memory by its integer rowid (vector index key).
   * @param rowid - SQLite rowid or equivalent.
   * @param organization - Organization namespace.
   */
  getMemoryByRowid(rowid: number, organization: string): Promise<MemoryRow | null>;

  /**
   * Batch fetch memories by rowids (one query). Optional — Wolbarg falls
   * back to parallel `getMemoryByRowid` when absent.
   *
   * @param rowids - Vector index row identifiers.
   * @param organization - Organization namespace.
   * @returns Map from rowid to row for hits only.
   */
  getMemoriesByRowids?(
    rowids: number[],
    organization: string,
  ): Promise<Map<number, MemoryRow>>;

  /**
   * List memories matching a filter.
   * @param filter - Organization, optional agent, archive, and metadata scope.
   * @param limit - Maximum rows (backend default when omitted).
   */
  listMemories(filter: RepositoryFilter, limit?: number): Promise<MemoryRow[]>;

  /**
   * Search memories by metadata filter only (no vector query).
   * @param filter - Must include organization; optional metadata AST.
   * @param limit - Maximum rows to return.
   */
  searchByMetadata(
    filter: RepositoryFilter,
    limit?: number,
  ): Promise<MemoryRow[]>;

  /**
   * KNN search against the vector index.
   * @param embedding - Query vector (same dimensionality as stored memories).
   * @param topK - Number of nearest neighbors.
   * @returns Hits with cosine distance (lower is more similar for sqlite-vec).
   */
  searchVectors(embedding: Float32Array, topK: number): Promise<VectorSearchHit[]>;

  /**
   * Optional: KNN + memory rows in one round-trip, org-scoped.
   *
   * @param embedding - Query vector.
   * @param topK - Neighbor count.
   * @param organization - Organization filter applied in SQL.
   * @param options - Optional agent filter and archive inclusion.
   */
  searchVectorsWithMemories?(
    embedding: Float32Array,
    topK: number,
    organization: string,
    options?: { agent?: string; includeArchived?: boolean },
  ): Promise<Array<{ row: MemoryRow; distance: number }>>;

  /**
   * Optional: native keyword / BM25 search (e.g. SQLite FTS5).
   * When present, hybrid recall can skip loading the full corpus.
   *
   * @param query - User search string.
   * @param organization - Organization namespace.
   * @param topK - Maximum lexical hits.
   */
  searchKeyword?(
    query: string,
    organization: string,
    topK: number,
  ): Promise<Array<{ memoryId: string; score: number }>>;

  /**
   * Soft-archive memories and record lineage linking them to a summary.
   *
   * @param ids - Memory UUIDs to archive.
   * @param organization - Organization namespace.
   * @param compressedIntoId - New summary memory id.
   * @param archivedAt - ISO timestamp for the archive event.
   * @returns The archived memory ids actually updated.
   */
  archiveMemories(
    ids: string[],
    organization: string,
    compressedIntoId: string,
    archivedAt: string,
  ): Promise<string[]>;

  /**
   * Hard-delete a single memory and its embedding.
   * @returns `true` when a row was deleted.
   */
  deleteMemoryById(id: string, organization: string): Promise<boolean>;

  /**
   * Hard-delete memories matching a filter.
   * @returns Count of deleted rows.
   */
  deleteMemoriesByFilter(filter: RepositoryFilter): Promise<number>;

  /**
   * Delete every memory for an organization.
   * @returns Count of deleted rows.
   */
  clearOrganization(organization: string): Promise<number>;

  /**
   * History events for a memory, oldest first.
   * @param memoryId - Memory UUID.
   */
  getHistory(memoryId: string): Promise<HistoryRow[]>;

  /** Append a history event (created, archived, compressed, updated). */
  insertHistoryEvent(event: HistoryRow): Promise<void>;

  /**
   * Count memories / distinct agents for an organization.
   * @param organization - Organization namespace.
   */
  getStats(organization: string): Promise<{
    totalMemories: number;
    activeMemories: number;
    archivedMemories: number;
    totalAgents: number;
  }>;

  /** Approximate on-disk database size in bytes. */
  getDatabaseSizeBytes(): Promise<number>;

  /**
   * Run `fn` inside a single ACID transaction.
   * @param fn - Synchronous or async work executed atomically.
   * @returns Value returned by `fn`.
   */
  withTransaction<T>(fn: () => T | Promise<T>): T | Promise<T>;
}

/** Back-compat alias for {@link StorageProvider}. */
export type DatabaseProvider = StorageProvider;
