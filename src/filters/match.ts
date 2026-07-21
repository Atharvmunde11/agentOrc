/**
 * In-memory metadata filter evaluation (used as fallback / post-filter).
 */

import type { MemoryMetadata } from "../types/index.js";
import type { MetadataComparison, MetadataFilter } from "./types.js";

function getField(metadata: MemoryMetadata, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = metadata;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(value: unknown, op: MetadataComparison): boolean {
  if ("eq" in op) {
    return value === op.eq;
  }
  if ("contains" in op) {
    if (typeof value === "string") {
      return value.includes(op.contains);
    }
    if (Array.isArray(value)) {
      return value.some((item) => String(item).includes(op.contains));
    }
    return false;
  }
  if ("gt" in op) {
    return value != null && (value as string | number) > op.gt;
  }
  if ("gte" in op) {
    return value != null && (value as string | number) >= op.gte;
  }
  if ("lt" in op) {
    return value != null && (value as string | number) < op.lt;
  }
  if ("lte" in op) {
    return value != null && (value as string | number) <= op.lte;
  }
  if ("between" in op) {
    const [lo, hi] = op.between;
    return value != null && value >= lo && value <= hi;
  }
  return false;
}

/**
 * Evaluate a metadata filter against an in-memory metadata object.
 *
 * Used as fallback when SQL push-down is unavailable or for post-filtering.
 *
 * @param metadata - Opaque memory metadata record.
 * @param filter - {@link MetadataFilter} AST to evaluate.
 * @returns `true` when the metadata satisfies the filter.
 */
export function matchesMetadata(
  metadata: MemoryMetadata,
  filter: MetadataFilter,
): boolean {
  if ("and" in filter) {
    return filter.and.every((f) => matchesMetadata(metadata, f));
  }
  if ("or" in filter) {
    return filter.or.some((f) => matchesMetadata(metadata, f));
  }
  if ("not" in filter) {
    return !matchesMetadata(metadata, filter.not);
  }
  return compare(getField(metadata, filter.field), filter.op);
}
