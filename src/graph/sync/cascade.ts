/**
 * Cascade delete helpers for the SQLite graph schema.
 *
 * Removes a memory graph node (and all incident edges) when the matching
 * memory is hard-deleted via forget/clear. Edge FK CASCADE covers edges when
 * the node row is deleted; we still delete edges explicitly first so partial
 * failures never leave dangling REFERENCES if FKs are off.
 */

import type { DatabaseSync } from "node:sqlite";

/** Relation used for entity → memory links (never walked by getRelated). */
export const ENTITY_MENTIONS_RELATION = "MENTIONS";

/**
 * Delete the memory graph node for `memoryId` and all edges that reference it.
 */
export function cascadeDeleteMemoryNode(
  db: DatabaseSync,
  memoryId: string,
): void {
  const node = db
    .prepare(
      `SELECT id FROM graph_nodes WHERE type = 'memory' AND ref_id = ?`,
    )
    .get(memoryId) as { id: string } | undefined;
  if (!node) return;

  db.prepare(
    `DELETE FROM graph_edges WHERE from_node_id = ? OR to_node_id = ?`,
  ).run(node.id, node.id);
  db.prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(node.id);
}
