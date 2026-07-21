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
  /** Relation type filter (e.g. `"follows"`, `"references"`). Omit for any relation. */
  relation?: string;
  /** Traversal depth from the start memory (default `1`). */
  depth?: number;
  /** Edge direction: incoming, outgoing, or both (default `"both"`). */
  direction?: GraphDirection;
}

/** Input for {@link GraphProvider.upsertEntity}. */
export interface GraphEntityInput {
  /** Human-readable entity name. */
  name: string;
  /** Entity type label (e.g. `"person"`, `"project"`). */
  type: string;
  /** Optional opaque metadata stored on the entity node. */
  metadata?: Record<string, unknown>;
}

/** Result of {@link GraphProvider.health}. */
export interface GraphHealthResult {
  /** Whether the graph backend is reachable and schema-ready. */
  ok: boolean;
  /** Backend identifier (e.g. `"sqlite-graph"`, `"neo4j"`). */
  backend: string;
  /** Backend-specific details (file path, cluster info, etc.). */
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

  /** Close the underlying connection and release resources. */
  close(): Promise<void>;

  /**
   * Create (or ensure) a directed relation between two memory nodes.
   * Implementations create stub Memory nodes when missing.
   *
   * @param fromId - Source memory UUID.
   * @param toId - Target memory UUID.
   * @param relation - Relation type label (e.g. `"references"`).
   * @param metadata - Optional edge properties.
   */
  linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Remove relation(s) between two memory nodes.
   *
   * @param fromId - Source memory UUID.
   * @param toId - Target memory UUID.
   * @param relation - When set, only remove edges of this type; omit to remove all between the pair.
   */
  unlinkMemories(
    fromId: string,
    toId: string,
    relation?: string,
  ): Promise<void>;

  /**
   * Traverse from a memory node and return related Memory records as stored
   * in the graph (facade may re-hydrate from SQL storage).
   *
   * @param memoryId - Start memory UUID.
   * @param options - Relation filter, depth, and direction.
   * @returns Related memories in graph-native form.
   */
  getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]>;

  /**
   * Upsert an entity node; returns stable entity id.
   *
   * @param entity - Entity name, type, and optional metadata.
   * @returns Stable entity UUID for {@link linkEntityToMemory}.
   */
  upsertEntity(entity: GraphEntityInput): Promise<string>;

  /**
   * Link an entity to a memory with an optional role.
   *
   * @param entityId - Entity UUID from {@link upsertEntity}.
   * @param memoryId - Memory UUID to link.
   * @param role - Optional relationship role (e.g. `"author"`, `"subject"`).
   */
  linkEntityToMemory(
    entityId: string,
    memoryId: string,
    role?: string,
  ): Promise<void>;

  /**
   * Hard-delete a memory node and all incident edges (cascade for forget/clear).
   *
   * @param memoryId - Memory UUID to remove from the graph.
   */
  deleteMemory(memoryId: string): Promise<void>;

  /**
   * Raw Cypher escape hatch. Supported on Neo4j only — the SQLite provider
   * throws a typed error. See module portability contract above.
   *
   * @param cypher - Cypher query string.
   * @param params - Bound parameters for the query.
   * @returns Driver-specific result rows.
   */
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown>;

  /**
   * Lightweight connectivity / schema health check.
   * @returns {@link GraphHealthResult} with `ok`, `backend`, and optional `details`.
   */
  health(): Promise<GraphHealthResult>;

  /**
   * When true, checkpoint/export may snapshot {@link getDataPath}.
   * Network-backed providers (Neo4j) return false.
   */
  supportsFileSnapshot(): boolean;

  /**
   * Absolute path to the embedded graph data directory/file, if any.
   * Returns `null` for networked backends (Neo4j).
   */
  getDataPath(): string | null;
}

/** Config shape accepted by `wolbarg({ graph: … })` when not passing an instance. */
export type GraphConfig =
  | {
      provider: "sqlite";
      /** File path for the embedded SQLite graph database. */
      path: string;
    }
  | {
      provider: "neo4j";
      /** Bolt or Neo4j URI (e.g. `bolt://localhost:7687`). */
      url: string;
      /** Neo4j username. */
      username: string;
      /** Neo4j password. */
      password: string;
      /** Optional Neo4j database name (default database when omitted). */
      database?: string;
    };

/** Either a {@link GraphProvider} instance or a {@link GraphConfig} object. */
export type GraphInput = GraphProvider | GraphConfig;
