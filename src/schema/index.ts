/**
 * SQL schema constants and migration statements.
 */

export const SCHEMA_VERSION = 2;

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (compressed_into) REFERENCES memories(id) ON DELETE SET NULL
);
`;

export const CREATE_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS memory_history (
  id TEXT PRIMARY KEY NOT NULL,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'archived', 'compressed')),
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

/** FTS5 index for keyword / BM25 search (schema v2). */
export const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content_text,
  memory_id UNINDEXED,
  organization UNINDEXED,
  agent UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memories_org_agent ON memories(organization, agent);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_org_archived ON memories(organization, archived);`,
  /** Active-set covering path for org-scoped list / stats / compress. */
  `CREATE INDEX IF NOT EXISTS idx_memories_org_active_created
     ON memories(organization, created_at) WHERE archived = 0;`,
  `CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_history_memory_id ON memory_history(memory_id);`,
] as const;

/**
 * Build the vec0 virtual table DDL for a fixed embedding dimensionality.
 * Cosine distance enables similarity = 1 - distance.
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
