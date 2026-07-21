/**
 * Compile MetadataFilter ASTs into SQLite json_extract predicates.
 * Returns null when the filter cannot be pushed down safely.
 */

import type { MetadataComparison, MetadataFilter } from "./types.js";

export interface CompiledMetadataSql {
  /** SQL boolean expression (no leading AND). */
  expression: string;
  params: unknown[];
}

const FIELD_RE =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

function jsonPath(field: string): string | null {
  if (!FIELD_RE.test(field)) {
    return null;
  }
  return `$.${field}`;
}

function compileComparison(
  field: string,
  op: MetadataComparison,
): CompiledMetadataSql | null {
  const path = jsonPath(field);
  if (!path) {
    return null;
  }
  const extract = `json_extract(metadata_json, '${path}')`;

  if ("eq" in op) {
    const value = op.eq;
    // SQLite treats `NULL = NULL` as NULL (unknown), so `IS NULL` isn't enough
    // to distinguish explicit JSON null vs missing keys. Use json_type(...)
    // which returns the string "null" only for explicit JSON null.
    if (value === null) {
      return {
        expression: `json_type(metadata_json, '${path}') = 'null'`,
        params: [],
      };
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    return { expression: `${extract} = ?`, params: [value] };
  }
  if ("contains" in op) {
    return {
      expression: `CAST(${extract} AS TEXT) LIKE '%' || ? || '%'`,
      params: [op.contains],
    };
  }
  if ("gt" in op) {
    return { expression: `${extract} > ?`, params: [op.gt] };
  }
  if ("gte" in op) {
    return { expression: `${extract} >= ?`, params: [op.gte] };
  }
  if ("lt" in op) {
    return { expression: `${extract} < ?`, params: [op.lt] };
  }
  if ("lte" in op) {
    return { expression: `${extract} <= ?`, params: [op.lte] };
  }
  if ("between" in op) {
    const [lo, hi] = op.between;
    return {
      expression: `${extract} >= ? AND ${extract} <= ?`,
      params: [lo, hi],
    };
  }
  return null;
}

/** Push a metadata filter into SQLite `json_extract` predicates, or `null` if unsupported. */
export function compileMetadataFilterToSql(
  filter: MetadataFilter,
): CompiledMetadataSql | null {
  if ("and" in filter) {
    if (filter.and.length === 0) {
      return { expression: "1", params: [] };
    }
    const parts: CompiledMetadataSql[] = [];
    for (const child of filter.and) {
      const compiled = compileMetadataFilterToSql(child);
      if (!compiled) {
        return null;
      }
      parts.push(compiled);
    }
    return {
      expression: parts.map((p) => `(${p.expression})`).join(" AND "),
      params: parts.flatMap((p) => p.params),
    };
  }
  if ("or" in filter) {
    if (filter.or.length === 0) {
      return { expression: "0", params: [] };
    }
    const parts: CompiledMetadataSql[] = [];
    for (const child of filter.or) {
      const compiled = compileMetadataFilterToSql(child);
      if (!compiled) {
        return null;
      }
      parts.push(compiled);
    }
    return {
      expression: parts.map((p) => `(${p.expression})`).join(" OR "),
      params: parts.flatMap((p) => p.params),
    };
  }
  if ("not" in filter) {
    const inner = compileMetadataFilterToSql(filter.not);
    if (!inner) {
      return null;
    }
    return {
      expression: `NOT (${inner.expression})`,
      params: inner.params,
    };
  }
  return compileComparison(filter.field, filter.op);
}
