/**
 * Shared provider contracts for Wolbarg v0.2.
 */

import type { MemoryMetadata } from "../types/index.js";
import type { MetadataFilter } from "../filters/types.js";

/** Row shape returned from the memories table. */
export interface MemoryRow {
  id: string;
  organization: string;
  agent: string;
  content_text: string;
  metadata_json: string;
  archived: number;
  compressed_into: string | null;
  created_at: string;
  updated_at: string;
  rowid?: number;
}

/** Row shape for memory history events. */
export interface HistoryRow {
  id: string;
  memory_id: string;
  event_type: "created" | "archived" | "compressed";
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
}

/** Payload for updating memory content / metadata. */
export interface UpdateMemoryInput {
  id: string;
  organization: string;
  contentText?: string;
  metadata?: MemoryMetadata;
  embedding?: Float32Array;
  updatedAt: string;
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
 * Public API never depends on a specific engine.
 */
export interface StorageProvider {
  readonly name: string;

  /** Open connection, enable WAL / pragmas, run migrations, prepare statements. */
  open(): Promise<void>;

  /** Close the underlying connection. */
  close(): Promise<void>;

  /** Ensure the vector table exists for the given embedding dimensionality. */
  ensureVectorSchema(dimensions: number): Promise<void>;

  /** Current embedding dimensionality stored in meta, or null if unset. */
  getEmbeddingDimensions(): Promise<number | null>;

  /** Persist embedding dimensionality in the meta table. */
  setEmbeddingDimensions(dimensions: number): Promise<void>;

  /** Insert a memory + embedding inside a single ACID transaction. */
  insertMemory(input: InsertMemoryInput): Promise<MemoryRow>;

  /** Batch insert memories + embeddings in one transaction. */
  insertMemoriesBatch(inputs: InsertMemoryInput[]): Promise<MemoryRow[]>;

  /** Update memory fields and optionally replace embedding. */
  updateMemory(input: UpdateMemoryInput): Promise<MemoryRow | null>;

  /** Fetch a memory by UUID. */
  getMemoryById(id: string, organization: string): Promise<MemoryRow | null>;

  /** Fetch a memory by its integer rowid. */
  getMemoryByRowid(rowid: number, organization: string): Promise<MemoryRow | null>;

  /**
   * Batch fetch memories by rowids (one query). Optional — Wolbarg falls
   * back to parallel getMemoryByRowid when absent.
   */
  getMemoriesByRowids?(
    rowids: number[],
    organization: string,
  ): Promise<Map<number, MemoryRow>>;

  /** List memories matching a filter. */
  listMemories(filter: RepositoryFilter, limit?: number): Promise<MemoryRow[]>;

  /** Search memories by metadata filter only. */
  searchByMetadata(
    filter: RepositoryFilter,
    limit?: number,
  ): Promise<MemoryRow[]>;

  /** KNN search against the vector index. */
  searchVectors(embedding: Float32Array, topK: number): Promise<VectorSearchHit[]>;

  /**
   * Optional: KNN + memory rows in one round-trip, org-scoped.
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
   */
  searchKeyword?(
    query: string,
    organization: string,
    topK: number,
  ): Promise<Array<{ memoryId: string; score: number }>>;

  /**
   * Soft-archive memories and record lineage linking them to a summary.
   * Returns the archived memory IDs.
   */
  archiveMemories(
    ids: string[],
    organization: string,
    compressedIntoId: string,
    archivedAt: string,
  ): Promise<string[]>;

  /** Hard-delete a single memory and its embedding. */
  deleteMemoryById(id: string, organization: string): Promise<boolean>;

  /** Hard-delete memories matching a filter. Returns deleted count. */
  deleteMemoriesByFilter(filter: RepositoryFilter): Promise<number>;

  /** Delete every memory for an organization. Returns deleted count. */
  clearOrganization(organization: string): Promise<number>;

  /** History events for a memory, oldest first. */
  getHistory(memoryId: string): Promise<HistoryRow[]>;

  /** Append a history event. */
  insertHistoryEvent(event: HistoryRow): Promise<void>;

  /** Count memories / distinct agents for an organization. */
  getStats(organization: string): Promise<{
    totalMemories: number;
    activeMemories: number;
    archivedMemories: number;
    totalAgents: number;
  }>;

  /** Approximate on-disk database size in bytes. */
  getDatabaseSizeBytes(): Promise<number>;

  /** Run `fn` inside a single ACID transaction. */
  withTransaction<T>(fn: () => T | Promise<T>): T | Promise<T>;
}

/** Back-compat alias. */
export type DatabaseProvider = StorageProvider;
