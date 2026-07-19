/**
 * Graph memory provider contract.
 *
 * Mirrors {@link StorageProvider} lifecycle naming (`open` / `close` / `health`
 * pattern via `health()`). Fully optional — omitting a graph provider does not
 * change existing memory behavior.
 *
 * ## Portability contract
 *
 * - The five typed methods (`linkMemories`, `unlinkMemories`, `getRelated`,
 *   `upsertEntity`, `linkEntityToMemory`) are **guaranteed** identical behavior
 *   across SQLite and Neo4j. This is the tested, supported contract (see
 *   `graph-parity.test.ts`).
 * - `query(cypher, params)` is supported on Neo4j only. The SQLite graph
 *   provider **hard-errors** immediately — SQLite has no Cypher. Use typed
 *   methods for portable code, or query the graph SQLite tables directly if you
 *   need raw SQL locally.
 * - `health()` guarantees only `ok` and `backend`. The `details` payload
 *   differs (embedded file path vs networked cluster/connection info).
 * - `deleteMemory` supports hard-delete cascade from `forget` / `clear` and is
 *   part of the portable typed surface.
 */

import type { MemoryRecord } from "../types/index.js";

/** Direction for {@link GraphProvider.getRelated}. */
export type GraphDirection = "in" | "out" | "both";

export interface GetRelatedOptions {
  relation?: string;
  /** Traversal depth (default 1). */
  depth?: number;
  direction?: GraphDirection;
}

export interface GraphEntityInput {
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface GraphHealthResult {
  ok: boolean;
  backend: string;
  details?: unknown;
}

/**
 * Pluggable graph store for memory–memory and entity–memory relations.
 *
 * Typed CRUD methods MUST be implemented with each backend’s native driver API
 * (not by routing through {@link GraphProvider.query}). `query()` is the
 * user-facing raw escape hatch only (Neo4j); SQLite throws.
 */
export interface GraphProvider {
  readonly name: string;

  /** Open connection / embedded database and ensure schema. */
  open(): Promise<void>;

  /** Close the underlying connection. */
  close(): Promise<void>;

  /**
   * Create (or ensure) a directed relation between two memory nodes.
   * Implementations create stub Memory nodes when missing.
   */
  linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /** Remove relation(s) between two memory nodes. */
  unlinkMemories(
    fromId: string,
    toId: string,
    relation?: string,
  ): Promise<void>;

  /**
   * Traverse from a memory node and return related Memory records as stored
   * in the graph (facade may re-hydrate from SQL storage).
   */
  getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]>;

  /** Upsert an entity node; returns stable entity id. */
  upsertEntity(entity: GraphEntityInput): Promise<string>;

  /** Link an entity to a memory with an optional role. */
  linkEntityToMemory(
    entityId: string,
    memoryId: string,
    role?: string,
  ): Promise<void>;

  /**
   * Hard-delete a memory node and all incident edges (cascade for forget/clear).
   */
  deleteMemory(memoryId: string): Promise<void>;

  /**
   * Raw Cypher escape hatch. Supported on Neo4j only — the SQLite provider
   * throws a typed error. See module portability contract above.
   */
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown>;

  health(): Promise<GraphHealthResult>;

  /**
   * When true, checkpoint/export may snapshot {@link getDataPath}.
   * Network-backed providers (Neo4j) return false.
   */
  supportsFileSnapshot(): boolean;

  /** Absolute path to the embedded graph data directory/file, if any. */
  getDataPath(): string | null;
}

/** Config shape accepted by `wolbarg({ graph: … })` when not passing an instance. */
export type GraphConfig =
  | {
      provider: "sqlite";
      path: string;
    }
  | {
      provider: "neo4j";
      url: string;
      username: string;
      password: string;
      database?: string;
    };

export type GraphInput = GraphProvider | GraphConfig;
