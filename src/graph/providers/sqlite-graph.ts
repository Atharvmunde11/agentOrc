/**
 * Embedded SQLite graph provider (file-backed, local/dev).
 *
 * Implements the five typed {@link GraphProvider} methods with plain SQL and
 * recursive CTEs — no Cypher. Schema is created on open (plain CREATE TABLE IF
 * NOT EXISTS; no graph-engine DDL / schema-creation-on-first-write complexity).
 *
 * Uses the same `node:sqlite` + {@link withImmediateTransaction} patterns as
 * {@link SqliteStorageProvider}. Graph data lives in a separate SQLite file from
 * the memory store by default.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConfigurationError, DatabaseError } from "../../errors/index.js";
import {
  CREATE_GRAPH_EDGES_TABLE,
  CREATE_GRAPH_INDEXES,
  CREATE_GRAPH_NODES_TABLE,
} from "../../schema/index.js";
import {
  resolveConcurrencyConfig,
  type ConcurrencyConfig,
  type ResolvedConcurrencyConfig,
} from "../../storage/sqlite/concurrency-config.js";
import { withImmediateTransaction } from "../../storage/sqlite/transaction.js";
import type { MemoryRecord } from "../../types/index.js";
import {
  entityIdFrom,
  serializeMetadata,
  stubMemoryRecord,
} from "../memory-node.js";
import {
  cascadeDeleteMemoryNode,
  ENTITY_MENTIONS_RELATION,
} from "../sync/cascade.js";
import type {
  GetRelatedOptions,
  GraphEntityInput,
  GraphHealthResult,
  GraphProvider,
} from "../types.js";

/** Default traversal depth when `options.depth` is omitted (matches Neo4j). */
export const DEFAULT_GET_RELATED_DEPTH = 1;
const MAX_GET_RELATED_DEPTH = 16;

export interface SqliteGraphProviderOptions {
  /** Path to the graph SQLite file (separate from the memory store by default). */
  path: string;
  /** Optional write-concurrency tuning (same shape as memory SQLite). */
  concurrency?: ConcurrencyConfig;
}

export class SqliteGraphProvider implements GraphProvider {
  readonly name = "sqlite";
  private readonly dbPath: string;
  private readonly concurrency: ResolvedConcurrencyConfig;
  private db: DatabaseSync | null = null;
  private opened = false;

  constructor(options: SqliteGraphProviderOptions) {
    if (!options?.path || typeof options.path !== "string" || !options.path.trim()) {
      throw new ConfigurationError("sqlite graph requires a non-empty path");
    }
    this.dbPath = path.resolve(options.path.trim());
    this.concurrency = resolveConcurrencyConfig(options.concurrency);
  }

  supportsFileSnapshot(): boolean {
    return this.dbPath !== ":memory:";
  }

  getDataPath(): string | null {
    return this.dbPath === ":memory:" ? null : this.dbPath;
  }

  async open(): Promise<void> {
    if (this.opened) return;

    try {
      if (this.dbPath !== ":memory:") {
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      }

      const db = new DatabaseSync(this.dbPath);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${this.concurrency.lockTimeoutMs};
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -8192;
        PRAGMA wal_autocheckpoint = 1000;
      `);

      db.exec(CREATE_GRAPH_NODES_TABLE);
      db.exec(CREATE_GRAPH_EDGES_TABLE);
      for (const indexSql of CREATE_GRAPH_INDEXES) {
        db.exec(indexSql);
      }

      this.db = db;
      this.opened = true;
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      this.opened = false;
      throw new DatabaseError(
        `Failed to open SQLite graph database: ${describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async close(): Promise<void> {
    if (!this.db) {
      this.opened = false;
      return;
    }
    try {
      try {
        this.db.exec("PRAGMA optimize;");
      } catch {
        /* best-effort */
      }
      this.db.close();
    } catch (error) {
      throw new DatabaseError(
        `Failed to close SQLite graph database: ${describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      this.db = null;
      this.opened = false;
    }
  }

  async linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const db = this.requireDb();
    await this.withTx(() => {
      const fromNode = this.ensureMemoryNodeSync(db, fromId);
      const toNode = this.ensureMemoryNodeSync(db, toId);
      db.prepare(
        `DELETE FROM graph_edges
         WHERE from_node_id = ? AND to_node_id = ? AND relation = ?`,
      ).run(fromNode, toNode, relation);
      db.prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, relation, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        fromNode,
        toNode,
        relation,
        serializeMetadata(metadata),
        nowIso(),
      );
    });
  }

  async unlinkMemories(
    fromId: string,
    toId: string,
    relation?: string,
  ): Promise<void> {
    const db = this.requireDb();
    await this.withTx(() => {
      const fromNode = this.findMemoryNodeId(db, fromId);
      const toNode = this.findMemoryNodeId(db, toId);
      if (!fromNode || !toNode) return;
      if (relation !== undefined) {
        db.prepare(
          `DELETE FROM graph_edges
           WHERE from_node_id = ? AND to_node_id = ? AND relation = ?`,
        ).run(fromNode, toNode, relation);
        return;
      }
      db.prepare(
        `DELETE FROM graph_edges WHERE from_node_id = ? AND to_node_id = ?`,
      ).run(fromNode, toNode);
    });
  }

  /**
   * Bounded recursive CTE over `graph_edges`.
   *
   * Default depth: {@link DEFAULT_GET_RELATED_DEPTH} (1). Cap: 16.
   * Only memory↔memory edges are walked (entity MENTIONS edges are excluded).
   * Cycle-safe via path membership (`instr`) so A→B→C→A terminates.
   *
   * Returns stub {@link MemoryRecord}s (id + empty fields). The facade
   * re-hydrates full rows via `toMemoryRecord` from storage when possible.
   */
  async getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]> {
    const db = this.requireDb();
    const depth = Math.max(
      1,
      Math.min(options?.depth ?? DEFAULT_GET_RELATED_DEPTH, MAX_GET_RELATED_DEPTH),
    );
    const direction = options?.direction ?? "both";
    const relation = options?.relation ?? null;

    const start = this.findMemoryNodeId(db, memoryId);
    if (!start) return [];

    const sql = buildGetRelatedSql(direction);
    // Bind: start id (anchor), start id (path seed), max depth, relation×2 (nullable filter).
    const rows = db
      .prepare(sql)
      .all(start, start, depth, relation, relation) as Array<{
      ref_id: string;
    }>;

    const seen = new Set<string>();
    const out: MemoryRecord[] = [];
    for (const row of rows) {
      if (row.ref_id === memoryId || seen.has(row.ref_id)) continue;
      seen.add(row.ref_id);
      out.push(stubMemoryRecord(row.ref_id));
    }
    return out;
  }

  async upsertEntity(entity: GraphEntityInput): Promise<string> {
    const id = entityIdFrom(entity.name, entity.type);
    const db = this.requireDb();
    const meta = serializeMetadata({
      ...(entity.metadata ?? {}),
      entityType: entity.type,
    });
    await this.withTx(() => {
      const existing = db
        .prepare(
          `SELECT id FROM graph_nodes WHERE type = 'entity' AND ref_id = ?`,
        )
        .get(id) as { id: string } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE graph_nodes SET name = ?, metadata = ? WHERE id = ?`,
        ).run(entity.name, meta, existing.id);
      } else {
        db.prepare(
          `INSERT INTO graph_nodes (id, type, ref_id, name, metadata, created_at)
           VALUES (?, 'entity', ?, ?, ?, ?)`,
        ).run(id, id, entity.name, meta, nowIso());
      }
    });
    return id;
  }

  async linkEntityToMemory(
    entityId: string,
    memoryId: string,
    role?: string,
  ): Promise<void> {
    const db = this.requireDb();
    await this.withTx(() => {
      const entity = db
        .prepare(
          `SELECT id FROM graph_nodes WHERE type = 'entity' AND ref_id = ?`,
        )
        .get(entityId) as { id: string } | undefined;
      if (!entity) {
        throw new DatabaseError(`Entity not found: ${entityId}`, {
          operation: "linkEntityToMemory",
        });
      }
      const memoryNode = this.ensureMemoryNodeSync(db, memoryId);
      db.prepare(
        `DELETE FROM graph_edges
         WHERE from_node_id = ? AND to_node_id = ? AND relation = ?`,
      ).run(entity.id, memoryNode, ENTITY_MENTIONS_RELATION);
      db.prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, relation, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        entity.id,
        memoryNode,
        ENTITY_MENTIONS_RELATION,
        serializeMetadata({ role: role ?? "" }),
        nowIso(),
      );
    });
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const db = this.requireDb();
    await this.withTx(() => {
      cascadeDeleteMemoryNode(db, memoryId);
    });
  }

  /**
   * Raw Cypher escape hatch — **not supported** on the SQLite graph provider.
   * Use the typed methods, or open the underlying SQLite file yourself for raw SQL.
   */
  async query(_cypher: string, _params?: Record<string, unknown>): Promise<unknown> {
    throw new DatabaseError(
      "raw Cypher queries are not supported by the SQLite graph provider — use the typed methods, or query the underlying SQLite tables directly via your own connection if you need raw access",
      {
        operation: "query",
        suggestion:
          "Use linkMemories / getRelated / upsertEntity / linkEntityToMemory, or open the graph .db file with node:sqlite for ad-hoc SQL",
      },
    );
  }

  async health(): Promise<GraphHealthResult> {
    try {
      if (!this.opened || !this.db) {
        return { ok: false, backend: "sqlite", details: { reason: "not open" } };
      }
      const nodeCount = Number(
        (this.db.prepare(`SELECT COUNT(*) AS c FROM graph_nodes`).get() as { c: number | bigint })
          .c,
      );
      const edgeCount = Number(
        (this.db.prepare(`SELECT COUNT(*) AS c FROM graph_edges`).get() as { c: number | bigint })
          .c,
      );
      return {
        ok: true,
        backend: "sqlite",
        details: {
          path: this.dbPath,
          embedded: true,
          nodeCount,
          edgeCount,
          exists: this.dbPath === ":memory:" || fs.existsSync(this.dbPath),
        },
      };
    } catch (error) {
      return {
        ok: false,
        backend: "sqlite",
        details: {
          path: this.dbPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async withTx<T>(fn: () => T): Promise<T> {
    const db = this.requireDb();
    return withImmediateTransaction(db, this.concurrency, fn);
  }

  private requireDb(): DatabaseSync {
    if (!this.db || !this.opened) {
      throw new DatabaseError("SQLite graph is not open", {
        operation: "graph",
        suggestion: "Call ready() / open() before graph operations",
      });
    }
    return this.db;
  }

  private findMemoryNodeId(db: DatabaseSync, memoryId: string): string | null {
    const row = db
      .prepare(
        `SELECT id FROM graph_nodes WHERE type = 'memory' AND ref_id = ?`,
      )
      .get(memoryId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private ensureMemoryNodeSync(db: DatabaseSync, memoryId: string): string {
    const existing = this.findMemoryNodeId(db, memoryId);
    if (existing) return existing;
    db.prepare(
      `INSERT INTO graph_nodes (id, type, ref_id, name, metadata, created_at)
       VALUES (?, 'memory', ?, NULL, '{}', ?)`,
    ).run(memoryId, memoryId, nowIso());
    return memoryId;
  }
}

/**
 * Build a recursive CTE for getRelated.
 * Bind order: startId, startId, maxDepth, relation, relation.
 * Path membership (`instr`) terminates cycles.
 */
function buildGetRelatedSql(direction: "in" | "out" | "both"): string {
  const mentions = ENTITY_MENTIONS_RELATION;

  if (direction === "out") {
    return `
      WITH RECURSIVE walk(node_id, depth, path) AS (
        SELECT ? AS node_id, 0, '/' || ? || '/'
        UNION ALL
        SELECT e.to_node_id, w.depth + 1, w.path || e.to_node_id || '/'
        FROM walk w
        JOIN graph_edges e ON e.from_node_id = w.node_id
        JOIN graph_nodes dest ON dest.id = e.to_node_id AND dest.type = 'memory'
        WHERE w.depth < ?
          AND instr(w.path, '/' || e.to_node_id || '/') = 0
          AND (? IS NULL OR e.relation = ?)
          AND e.relation != '${mentions}'
      )
      SELECT DISTINCT n.ref_id AS ref_id
      FROM walk w
      JOIN graph_nodes n ON n.id = w.node_id
      WHERE w.depth > 0 AND n.type = 'memory'
    `;
  }

  if (direction === "in") {
    return `
      WITH RECURSIVE walk(node_id, depth, path) AS (
        SELECT ? AS node_id, 0, '/' || ? || '/'
        UNION ALL
        SELECT e.from_node_id, w.depth + 1, w.path || e.from_node_id || '/'
        FROM walk w
        JOIN graph_edges e ON e.to_node_id = w.node_id
        JOIN graph_nodes src ON src.id = e.from_node_id AND src.type = 'memory'
        WHERE w.depth < ?
          AND instr(w.path, '/' || e.from_node_id || '/') = 0
          AND (? IS NULL OR e.relation = ?)
          AND e.relation != '${mentions}'
      )
      SELECT DISTINCT n.ref_id AS ref_id
      FROM walk w
      JOIN graph_nodes n ON n.id = w.node_id
      WHERE w.depth > 0 AND n.type = 'memory'
    `;
  }

  return `
    WITH RECURSIVE walk(node_id, depth, path) AS (
      SELECT ? AS node_id, 0, '/' || ? || '/'
      UNION ALL
      SELECT neighbor.id, w.depth + 1, w.path || neighbor.id || '/'
      FROM walk w
      JOIN graph_edges e
        ON e.from_node_id = w.node_id OR e.to_node_id = w.node_id
      JOIN graph_nodes neighbor
        ON neighbor.id = CASE
             WHEN e.from_node_id = w.node_id THEN e.to_node_id
             ELSE e.from_node_id
           END
        AND neighbor.type = 'memory'
      WHERE w.depth < ?
        AND instr(w.path, '/' || neighbor.id || '/') = 0
        AND (? IS NULL OR e.relation = ?)
        AND e.relation != '${mentions}'
    )
    SELECT DISTINCT n.ref_id AS ref_id
    FROM walk w
    JOIN graph_nodes n ON n.id = w.node_id
    WHERE w.depth > 0 AND n.type = 'memory'
  `;
}

function nowIso(): string {
  return new Date().toISOString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
