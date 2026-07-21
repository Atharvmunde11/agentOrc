/**
 * Prepared-statement SQL templates for the SQLite provider.
 *
 * Each property is a parameterized query string consumed by
 * {@link SqliteStorageProvider} — not a public runtime API, but exported
 * for tests, tooling, and custom SQLite adapters.
 */
export const SQL = {
  getMeta: `SELECT value FROM Wolbarg_meta WHERE key = ?`,
  setMeta: `
    INSERT INTO Wolbarg_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,

  insertMemory: `
    INSERT INTO memories (
      id, organization, agent, content_text, metadata_json,
      archived, compressed_into, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    RETURNING rowid, id, organization, agent, content_text, metadata_json,
              archived, compressed_into, content_hash, created_at, updated_at
  `,

  getMemoryById: `
    SELECT rowid, id, organization, agent, content_text, metadata_json,
           archived, compressed_into, content_hash, created_at, updated_at
    FROM memories
    WHERE id = ? AND organization = ?
  `,

  getMemoryByRowid: `
    SELECT rowid, id, organization, agent, content_text, metadata_json,
           archived, compressed_into, content_hash, created_at, updated_at
    FROM memories
    WHERE rowid = ? AND organization = ?
  `,

  getMemoriesByRowidsPrefix: `
    SELECT rowid, id, organization, agent, content_text, metadata_json,
           archived, compressed_into, content_hash, created_at, updated_at
    FROM memories
    WHERE organization = ? AND rowid IN (
  `,

  listMemoriesBase: `
    SELECT rowid, id, organization, agent, content_text, metadata_json,
           archived, compressed_into, content_hash, created_at, updated_at
    FROM memories
    WHERE organization = ?
  `,

  findActiveByContentHash: `
    SELECT rowid, id, organization, agent, content_text, metadata_json,
           archived, compressed_into, content_hash, created_at, updated_at
    FROM memories
    WHERE organization = ? AND agent = ? AND content_hash = ? AND archived = 0
    LIMIT 1
  `,

  insertEmbedding: `
    INSERT INTO memory_embeddings (memory_rowid, embedding) VALUES (?, ?)
  `,

  deleteEmbedding: `
    DELETE FROM memory_embeddings WHERE memory_rowid = ?
  `,

  searchVectors: `
    SELECT memory_rowid, distance
    FROM memory_embeddings
    WHERE embedding MATCH ?
      AND k = ?
  `,

  insertEmbeddingBlob: `
    INSERT OR REPLACE INTO memory_embeddings_blob (memory_rowid, embedding) VALUES (?, ?)
  `,

  deleteEmbeddingBlob: `
    DELETE FROM memory_embeddings_blob WHERE memory_rowid = ?
  `,

  listEmbeddingsBlob: `
    SELECT memory_rowid, embedding FROM memory_embeddings_blob
  `,

  archiveMemory: `
    UPDATE memories
    SET archived = 1,
        compressed_into = ?,
        updated_at = ?
    WHERE id = ? AND organization = ? AND archived = 0
  `,

  deleteMemoryById: `
    DELETE FROM memories WHERE id = ? AND organization = ?
  `,

  deleteMemoriesByOrg: `
    DELETE FROM memories WHERE organization = ?
  `,

  deleteMemoriesByOrgAgent: `
    DELETE FROM memories WHERE organization = ? AND agent = ?
  `,

  insertHistory: `
    INSERT INTO memory_history (id, memory_id, event_type, related_memory_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `,

  getHistory: `
    SELECT id, memory_id, event_type, related_memory_id, created_at
    FROM memory_history
    WHERE memory_id = ?
    ORDER BY created_at ASC
  `,

  countMemories: `
    SELECT COUNT(*) AS count FROM memories WHERE organization = ?
  `,

  countActiveMemories: `
    SELECT COUNT(*) AS count FROM memories WHERE organization = ? AND archived = 0
  `,

  countArchivedMemories: `
    SELECT COUNT(*) AS count FROM memories WHERE organization = ? AND archived = 1
  `,

  countAgents: `
    SELECT COUNT(DISTINCT agent) AS count FROM memories WHERE organization = ? AND archived = 0
  `,

  /** FTS ranked by BM25 (archived rows are deleted from FTS on archive). */
  searchFts: `
    SELECT memory_id, bm25(memories_fts) AS rank
    FROM memories_fts
    WHERE memories_fts MATCH ?
      AND organization = ?
    ORDER BY rank
    LIMIT ?
  `,

  listRowidsForOrg: `
    SELECT rowid FROM memories WHERE organization = ?
  `,

  listRowidsForOrgAgent: `
    SELECT rowid FROM memories WHERE organization = ? AND agent = ?
  `,

  vectorTableExists: `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'memory_embeddings'
  `,

  updateMemoryContent: `
    UPDATE memories
    SET content_text = COALESCE(?, content_text),
        metadata_json = COALESCE(?, metadata_json),
        content_hash = COALESCE(?, content_hash),
        updated_at = ?
    WHERE id = ? AND organization = ?
  `,

  insertFts: `
    INSERT INTO memories_fts (content_text, memory_id, organization, agent)
    VALUES (?, ?, ?, ?)
  `,

  deleteFts: `
    DELETE FROM memories_fts WHERE memory_id = ?
  `,

  deleteFtsByOrg: `
    DELETE FROM memories_fts WHERE organization = ?
  `,

  deleteFtsByOrgAgent: `
    DELETE FROM memories_fts WHERE organization = ? AND agent = ?
  `,

  deleteEmbeddingsByOrg: `
    DELETE FROM memory_embeddings WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE organization = ?
    )
  `,

  deleteEmbeddingsByOrgAgent: `
    DELETE FROM memory_embeddings WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE organization = ? AND agent = ?
    )
  `,

  deleteEmbeddingsBlobByOrg: `
    DELETE FROM memory_embeddings_blob WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE organization = ?
    )
  `,

  deleteEmbeddingsBlobByOrgAgent: `
    DELETE FROM memory_embeddings_blob WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE organization = ? AND agent = ?
    )
  `,

  deleteArchivedEmbeddings: `
    DELETE FROM memory_embeddings WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE archived = 1
    )
  `,

  deleteArchivedEmbeddingsBlob: `
    DELETE FROM memory_embeddings_blob WHERE memory_rowid IN (
      SELECT rowid FROM memories WHERE archived = 1
    )
  `,

  /** Single-pass org stats (avoids 4 separate COUNT queries). */
  getStats: `
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0) AS archived,
      COUNT(DISTINCT CASE WHEN archived = 0 THEN agent END) AS agents
    FROM memories
    WHERE organization = ?
  `,
} as const;
