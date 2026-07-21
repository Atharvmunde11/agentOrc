/**
 * SQL schema constants and migration statements.
 */

/** Current schema version written to `Wolbarg_meta.schema_version`. */
export const SCHEMA_VERSION = 4;

/** Keys stored in the `Wolbarg_meta` key-value table. */
export const META_KEYS = {
  schemaVersion: "schema_version",
  embeddingDimensions: "embedding_dimensions",
  vectorBackend: "vector_backend",
} as const;

/** Vector storage backend used by the SQLite provider. */
export type VectorBackend = "sqlite-vec" | "blob";

export const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS Wolbarg_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export const CREATE_MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY NOT NULL,
  organization TEXT NOT NULL,
  agent TEXT NOT NULL,
  content_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  compressed_into TEXT NULL,
  content_hash TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (compressed_into) REFERENCES memories(id) ON DELETE SET NULL
);
`;

export const CREATE_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS memory_history (
  id TEXT PRIMARY KEY NOT NULL,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'archived', 'compressed', 'updated')),
  related_memory_id TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
`;

/** Fallback embedding store used when sqlite-vec is unavailable on the platform. */
export const CREATE_BLOB_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS memory_embeddings_blob (
  memory_rowid INTEGER PRIMARY KEY NOT NULL,
  embedding BLOB NOT NULL
);
`;

/**
 * FTS5 index for keyword / BM25 search.
 * `organization` stays UNINDEXED so tenant IDs are not Porter-tokenized;
 * equality filters and bulk DELETE BY organization still use the stored value.
 */
export const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content_text,
  memory_id UNINDEXED,
  organization UNINDEXED,
  agent UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

export const CREATE_EMBEDDING_CACHE_TABLE = `
CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
`;

/**
 * Graph memory tables (SQLite graph provider — separate DB file by default).
 * `type` is the node kind (`memory` | `entity`); entity classification lives in metadata.
 */
export const CREATE_GRAPH_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('memory', 'entity')),
  ref_id TEXT NOT NULL,
  name TEXT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

export const CREATE_GRAPH_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (from_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
);
`;

/** Indexes required for in-SQL recursive CTE graph walks. */
export const CREATE_GRAPH_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_ref
     ON graph_nodes(type, ref_id);`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_from
     ON graph_edges(from_node_id);`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_to
     ON graph_edges(to_node_id);`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_from_rel
     ON graph_edges(from_node_id, relation);`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_to_rel
     ON graph_edges(to_node_id, relation);`,
] as const;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memories_org_agent ON memories(organization, agent);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_org_archived ON memories(organization, archived);`,
  /** Active-set path for org-scoped list / stats / compress. */
  `CREATE INDEX IF NOT EXISTS idx_memories_org_active_created
     ON memories(organization, created_at) WHERE archived = 0;`,
  /** Agent-scoped active list (compress / forget-by-agent). */
  `CREATE INDEX IF NOT EXISTS idx_memories_org_agent_active_created
     ON memories(organization, agent, created_at) WHERE archived = 0;`,
  `CREATE INDEX IF NOT EXISTS idx_history_memory_id ON memory_history(memory_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_org_agent_hash_active
     ON memories(organization, agent, content_hash)
     WHERE archived = 0 AND content_hash IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used
     ON embedding_cache(last_used_at);`,
] as const;

/** Dropped in schema v4 — global created_at index was unused (all queries scope by org). */
export const DROP_REDUNDANT_INDEXES_V4 = [
  `DROP INDEX IF EXISTS idx_memories_created_at;`,
] as const;

/**
 * Build the vec0 virtual table DDL for a fixed embedding dimensionality.
 * Cosine distance enables similarity = 1 - distance.
 *
 * @param dimensions - Embedding vector length (positive integer).
 * @returns `CREATE VIRTUAL TABLE … vec0(…)` DDL string.
 * @throws {Error} When dimensions is not a positive integer.
 */
export function buildVectorTableSql(dimensions: number): string {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
  memory_rowid INTEGER PRIMARY KEY,
  embedding float[${dimensions}] distance_metric=cosine
);
`;
}
