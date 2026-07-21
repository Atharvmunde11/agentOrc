/**
 * Memory domain helpers — mapping rows to public records.
 */

import type { HistoryEvent, MemoryRecord, RecallResult } from "../types/index.js";
import type { HistoryRow, MemoryRow } from "../storage/types.js";
import { deserializeMetadata, parseIso } from "../utils/index.js";

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

