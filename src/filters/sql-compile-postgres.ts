/**
 * Compile MetadataFilter ASTs into PostgreSQL JSONB predicates.
 * Returns null when the filter cannot be pushed down safely.
 */

import type { MetadataComparison, MetadataFilter } from "./types.js";
import type { CompiledMetadataSql } from "./sql-compile.js";

const FIELD_RE =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

/** Safe identifier path → JSONB text extract expression (no bind params). */
function jsonbTextExtract(field: string): string | null {
  if (!FIELD_RE.test(field)) {
    return null;
  }
  const parts = field.split(".");
  if (parts.length === 1) {
    return `metadata_json->>'${parts[0]}'`;
  }
  const path = parts.join(",");
  return `metadata_json #>> '{${path}}'`;
}

function jsonbContainment(
  field: string,
  value: string | number | boolean | null,
  paramIndex: number,
): CompiledMetadataSql | null {
  if (!FIELD_RE.test(field)) {
    return null;
  }
  const parts = field.split(".");
  let obj: unknown = value;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    obj = { [parts[i]!]: obj };
  }
  return {
    expression: `metadata_json @> $${paramIndex}::jsonb`,
    params: [JSON.stringify(obj)],
  };
}

function compileComparison(
  field: string,
  op: MetadataComparison,
  startIndex: number,
): CompiledMetadataSql | null {
  if ("eq" in op) {
    const value = op.eq;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    return jsonbContainment(field, value, startIndex);
  }

  const extract = jsonbTextExtract(field);
  if (!extract) {
    return null;
  }

  if ("contains" in op) {
    return {
      expression: `${extract} LIKE '%' || $${startIndex} || '%'`,
      params: [op.contains],
    };
  }
  if ("gt" in op) {
    return {
      expression: `(${extract})::numeric > $${startIndex}`,
      params: [op.gt],
    };
  }
  if ("gte" in op) {
    return {
      expression: `(${extract})::numeric >= $${startIndex}`,
      params: [op.gte],
    };
  }
  if ("lt" in op) {
    return {
      expression: `(${extract})::numeric < $${startIndex}`,
      params: [op.lt],
    };
  }
  if ("lte" in op) {
    return {
      expression: `(${extract})::numeric <= $${startIndex}`,
      params: [op.lte],
    };
  }
  if ("between" in op) {
    const [lo, hi] = op.between;
    return {
      expression: `(${extract})::numeric >= $${startIndex} AND (${extract})::numeric <= $${startIndex + 1}`,
      params: [lo, hi],
    };
  }
  return null;
}

function compileInner(
  filter: MetadataFilter,
  startIndex: number,
): CompiledMetadataSql | null {
  if ("and" in filter) {
    if (filter.and.length === 0) {
      return { expression: "TRUE", params: [] };
    }
    const parts: CompiledMetadataSql[] = [];
    let idx = startIndex;
    for (const child of filter.and) {
      const compiled = compileInner(child, idx);
      if (!compiled) {
        return null;
      }
      parts.push(compiled);
      idx += compiled.params.length;
    }
    return {
      expression: parts.map((p) => `(${p.expression})`).join(" AND "),
      params: parts.flatMap((p) => p.params),
    };
  }
  if ("or" in filter) {
    if (filter.or.length === 0) {
      return { expression: "FALSE", params: [] };
    }
    const parts: CompiledMetadataSql[] = [];
    let idx = startIndex;
    for (const child of filter.or) {
      const compiled = compileInner(child, idx);
      if (!compiled) {
        return null;
      }
      parts.push(compiled);
      idx += compiled.params.length;
    }
    return {
      expression: parts.map((p) => `(${p.expression})`).join(" OR "),
      params: parts.flatMap((p) => p.params),
    };
  }
  if ("not" in filter) {
    const inner = compileInner(filter.not, startIndex);
    if (!inner) {
      return null;
    }
    return {
      expression: `NOT (${inner.expression})`,
      params: inner.params,
    };
  }
  return compileComparison(filter.field, filter.op, startIndex);
}

/**
 * Push a metadata filter into PostgreSQL JSONB predicates, or `null` if unsupported.
 * Parameter placeholders are `$N` starting at `startIndex` (default `1`).
 *
 * @param filter - Metadata filter AST.
 * @param startIndex - First `$N` index for bound parameters.
 */
export function compileMetadataFilterToPostgres(
  filter: MetadataFilter,
  startIndex = 1,
): CompiledMetadataSql | null {
  return compileInner(filter, startIndex);
}
