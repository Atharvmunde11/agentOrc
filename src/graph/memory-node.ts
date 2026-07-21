/**
 * Shared Memory / Entity serialization helpers for graph backends.
 */

import type { MemoryRecord } from "../types/index.js";

/** Minimal stub when only an id is known. */
export function stubMemoryRecord(id: string): MemoryRecord {
  return {
    id,
    organization: "",
    agent: "",
    content: { text: "" },
    metadata: {},
    archived: false,
    compressedInto: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Serialize graph node metadata to a JSON string (`{}` when undefined). */
export function serializeMetadata(meta: Record<string, unknown> | undefined): string {
  return JSON.stringify(meta ?? {});
}

/**
 * Deserialize graph node metadata from storage (object, JSON string, or empty).
 *
 * @param raw - Value from SQLite / Neo4j column.
 * @returns Plain metadata object; invalid input becomes `{}`.
 */
export function deserializeMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Map a storage or Cypher row into a {@link MemoryRecord}.
 *
 * @param row - Snake_case or camelCase column names from graph backends.
 */
export function rowToMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  const id = String(row.id ?? row.n_id ?? "");
  const createdAt = parseDate(row.created_at ?? row.createdAt);
  const updatedAt = parseDate(row.updated_at ?? row.updatedAt);
  return {
    id,
    organization: String(row.organization ?? ""),
    agent: String(row.agent ?? ""),
    content: { text: String(row.content_text ?? row.contentText ?? "") },
    metadata: deserializeMetadata(row.metadata_json ?? row.metadata),
    archived: Boolean(row.archived),
    compressedInto:
      row.compressed_into == null || row.compressed_into === ""
        ? null
        : String(row.compressed_into),
    createdAt,
    updatedAt,
  };
}

function parseDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/**
 * Stable entity id from name+type (portable across backends).
 *
 * @param name - Human-readable entity label.
 * @param type - Entity classification (e.g. `"person"`, `"project"`).
 * @returns Deterministic id prefixed with `ent_`.
 */
export function entityIdFrom(name: string, type: string): string {
  const key = `${type.trim().toLowerCase()}::${name.trim().toLowerCase()}`;
  // Simple deterministic hash → hex (no crypto dependency required).
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = (h >>> 0).toString(16).padStart(8, "0");
  let h2 = 5381;
  for (let i = 0; i < key.length; i += 1) {
    h2 = (h2 * 33) ^ key.charCodeAt(i);
  }
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return `ent_${a}${b}`;
}
