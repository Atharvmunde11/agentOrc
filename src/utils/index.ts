/**
 * Shared utility helpers.
 */

import { ValidationError } from "../errors/index.js";

/** Generate a RFC 4122 version 4 UUID. */
export function createId(): string {
  return crypto.randomUUID();
}

/** Current UTC timestamp as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse an ISO-8601 string into a Date. */
export function parseIso(value: string): Date {
  return new Date(value);
}

/** Assert that a string is non-empty after trimming.
 *
 * @param value - Candidate string.
 * @param fieldName - Field label used in the error message.
 * @throws {ValidationError} When value is missing, not a string, or blank.
 */
export function assertNonEmptyString(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
}

/** Assert that a value is a finite number within an optional range.
 *
 * @param value - Candidate number.
 * @param fieldName - Field label used in the error message.
 * @param options.min - Optional inclusive lower bound.
 * @param options.max - Optional inclusive upper bound.
 * @throws {ValidationError} When value is not a finite number or out of range.
 */
export function assertFiniteNumber(
  value: unknown,
  fieldName: string,
  options?: { min?: number; max?: number },
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${fieldName} must be a finite number`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(`${fieldName} must be >= ${options.min}`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(`${fieldName} must be <= ${options.max}`);
  }
}

const EMPTY_META_JSON = "{}";

/** Safely serialize opaque metadata to JSON text.
 *
 * @param metadata - Plain object metadata (empty object serializes to `{}`).
 */
export function serializeMetadata(metadata: Record<string, unknown>): string {
  for (const _key in metadata) {
    return JSON.stringify(metadata);
  }
  return EMPTY_META_JSON;
}

/** Safely deserialize opaque metadata from JSON text.
 *
 * @param raw - JSON string from storage (invalid JSON returns `{}`).
 */
export function deserializeMetadata(raw: string): Record<string, unknown> {
  if (!raw || raw === EMPTY_META_JSON) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Convert a Float32Array embedding into a Buffer suitable for sqlite-vec.
 *
 * @param embedding - Model output vector (must match configured dimensions).
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert cosine distance (as returned by sqlite-vec) to cosine similarity.
 * sqlite-vec cosine distance ≈ `1 - cosine_similarity`, range roughly [0, 2].
 *
 * @param distance - Cosine distance from vec0 / blob fallback search.
 * @returns Similarity score in roughly [-1, 1] (typically [0, 1] for normalized embeddings).
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

/**
 * Simple async mutex for serializing write-critical sections across
 * concurrent async callers in the same process.
 */
export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  /**
   * Run `fn` exclusively — concurrent callers queue on the same mutex.
   *
   * @param fn - Async or sync work to serialize.
   * @returns The value returned by `fn`.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Join a base URL with a path, avoiding duplicate slashes.
 *
 * @param baseUrl - Origin or prefix URL (trailing slashes stripped).
 * @param path - Path segment (leading slash optional).
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
