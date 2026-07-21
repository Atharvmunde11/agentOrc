/**
 * Memory domain helpers — map storage rows to public API types.
 *
 * Used internally by the Wolbarg facade and exportable for custom tooling.
 */

import type { HistoryEvent, MemoryRecord, RecallResult } from "../types/index.js";
import type { HistoryRow, MemoryRow } from "../storage/types.js";
import { deserializeMetadata, parseIso } from "../utils/index.js";

/**
 * Convert a storage {@link MemoryRow} to a public {@link MemoryRecord}.
 *
 * @param row - Raw database row.
 * @returns Parsed memory with Date objects and deserialized metadata.
 */
export function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    organization: row.organization,
    agent: row.agent,
    content: { text: row.content_text },
    metadata: deserializeMetadata(row.metadata_json),
    archived: row.archived === 1,
    compressedInto: row.compressed_into,
    createdAt: parseIso(row.created_at),
    updatedAt: parseIso(row.updated_at),
  };
}

/**
 * Convert a storage row plus similarity score to a {@link RecallResult}.
 *
 * @param row - Raw database row.
 * @param similarity - Cosine similarity in `[0, 1]` (higher is better).
 */
export function toRecallResult(row: MemoryRow, similarity: number): RecallResult {
  return {
    id: row.id,
    organization: row.organization,
    agent: row.agent,
    content: { text: row.content_text },
    metadata: deserializeMetadata(row.metadata_json),
    archived: row.archived === 1,
    similarity,
    createdAt: parseIso(row.created_at),
    updatedAt: parseIso(row.updated_at),
  };
}

/**
 * Convert a history table row to a public {@link HistoryEvent}.
 *
 * @param row - Raw history row from storage.
 */
export function toHistoryEvent(row: HistoryRow): HistoryEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    relatedMemoryId: row.related_memory_id,
    createdAt: parseIso(row.created_at),
  };
}

export {
  SqliteMemoryTransferProvider,
} from "./transfer.js";
export type {
  ExportManifest,
  MemoryExportResult,
  MemoryImportResult,
  MemoryTransferProvider,
} from "./transfer.js";

export {
  normalizeConversationMessages,
  resolveRememberFromMessagesOptions,
  selectRawUserTexts,
  buildExtractMessages,
  parseExtractedFacts,
} from "./from-messages.js";
