/**
 * Transparent embedding cache wrapping any {@link EmbeddingProviderLike}.
 *
 * Keys are `sha256(content):model` so identical text across agents shares vectors.
 * Use {@link withEmbeddingCache} with a {@link EmbeddingCacheStore} implementation.
 */

import { createHash } from "node:crypto";

/**
 * Minimal embedding provider contract for cache wrapping.
 * Avoids circular import with `embedding/index.ts`.
 */
export interface EmbeddingProviderLike {
  /** Model name included in cache keys. */
  readonly model: string;
  /** Embed a single text string. */
  embed(text: string): Promise<Float32Array>;
  /** Optional batch embed (cache checks each item before batching misses). */
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
  /** Validate provider connectivity and return embedding dimensions. */
  validate(): Promise<{ dimensions: number }>;
}

/** User-facing embedding cache configuration (constructor / options). */
export interface EmbeddingCacheConfig {
  /** Enable cache (default `true` in 0.4+). */
  enabled?: boolean;
  /** Lazy TTL expiry on read; default no expiry. */
  ttlMs?: number;
  /** LRU eviction cap; default unbounded in-memory + durable store limits. */
  maxEntries?: number;
}

/** Normalized cache config after defaults are applied. */
export interface ResolvedEmbeddingCacheConfig {
  enabled: boolean;
  ttlMs: number | null;
  maxEntries: number | null;
}

/**
 * Resolve embedding cache config with SDK defaults.
 *
 * @param input - Optional partial config from `wolbarg({ embeddingCache })`.
 */
export function resolveEmbeddingCacheConfig(
  input?: EmbeddingCacheConfig,
): ResolvedEmbeddingCacheConfig {
  return {
    enabled: input?.enabled ?? true,
    ttlMs: input?.ttlMs ?? null,
    maxEntries: input?.maxEntries ?? null,
  };
}

/**
 * Build a deterministic cache key from content and model name.
 *
 * @param content - Raw text that was embedded.
 * @param model - Embedding model identifier.
 */
export function embeddingCacheKey(content: string, model: string): string {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return `${hash}:${model}`;
}

/**
 * Pluggable durable / in-memory store for cached embedding vectors.
 *
 * Implement for Redis, S3, or other shared caches across processes.
 */
export interface EmbeddingCacheStore {
  /** Lookup a cached vector; return `null` on miss or expiry. */
  get(cacheKey: string): Promise<Float32Array | null>;
  /** Store a vector (may be write-behind). */
  set(cacheKey: string, model: string, vector: Float32Array): Promise<void>;
  /** Update LRU timestamp for a key (optional optimization). */
  touch(cacheKey: string): Promise<void>;
  /** Evict oldest entries when count exceeds `maxEntries`. */
  evictIfNeeded(maxEntries: number): Promise<void>;
}

/** Embedding provider wrapped with hit/miss statistics. */
export interface CacheAwareEmbedding extends EmbeddingProviderLike {
  /** Cache hits since construction or last {@link CacheAwareEmbedding.resetCacheStats}. */
  readonly cacheHits: number;
  /** Cache misses in the same window. */
  readonly cacheMisses: number;
  /** Reset hit/miss counters to zero. */
  resetCacheStats(): void;
}

/**
 * Wrap an embedding provider with a content+model cache.
 *
 * Cache check happens per-item before batch assembly so repeated texts never
 * hit the embedding API.
 *
 * @param provider - Underlying embedding provider.
 * @param store - L1 + durable cache store.
 * @param config - Resolved cache options from {@link resolveEmbeddingCacheConfig}.
 * @returns Provider with identical API plus cache stats.
 *
 * @example
 * ```ts
 * const cached = withEmbeddingCache(embedding, sqliteStore, resolveEmbeddingCacheConfig());
 * ```
 */
export function withEmbeddingCache(
  provider: EmbeddingProviderLike,
  store: EmbeddingCacheStore,
  config: ResolvedEmbeddingCacheConfig,
): CacheAwareEmbedding {
  let cacheHits = 0;
  let cacheMisses = 0;

  async function embedOne(text: string): Promise<Float32Array> {
    if (!config.enabled) {
      cacheMisses += 1;
      return provider.embed(text);
    }
    const key = embeddingCacheKey(text, provider.model);
    const cached = await store.get(key);
    if (cached) {
      cacheHits += 1;
      // LRU touch is batched inside SqliteEmbeddingCacheStore.get — no per-hit write here.
      return cached;
    }
    cacheMisses += 1;
    const vector = await provider.embed(text);
    // Fire-and-forget durable write — L1 is updated synchronously inside set().
    void store.set(key, provider.model, vector);
    if (config.maxEntries !== null) {
      void store.evictIfNeeded(config.maxEntries);
    }
    return vector;
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!config.enabled || texts.length === 0) {
      if (provider.embedBatch) {
        cacheMisses += texts.length;
        return provider.embedBatch(texts);
      }
      return Promise.all(texts.map((t) => embedOne(t)));
    }

    const results: Array<Float32Array | null> = new Array(texts.length).fill(
      null,
    );
    const missIndexes: number[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i]!;
      const key = embeddingCacheKey(text, provider.model);
      const cached = await store.get(key);
      if (cached) {
        cacheHits += 1;
        results[i] = cached;
      } else {
        missIndexes.push(i);
        missTexts.push(text);
      }
    }

    if (missTexts.length > 0) {
      cacheMisses += missTexts.length;
      const vectors = provider.embedBatch
        ? await provider.embedBatch(missTexts)
        : await Promise.all(missTexts.map((t) => provider.embed(t)));
      for (let j = 0; j < missIndexes.length; j += 1) {
        const idx = missIndexes[j]!;
        const vector = vectors[j]!;
        results[idx] = vector;
        const key = embeddingCacheKey(missTexts[j]!, provider.model);
        void store.set(key, provider.model, vector);
      }
      if (config.maxEntries !== null) {
        void store.evictIfNeeded(config.maxEntries);
      }
    }

    return results as Float32Array[];
  }

  return {
    model: provider.model,
    embed: embedOne,
    embedBatch,
    validate: () => provider.validate(),
    get cacheHits() {
      return cacheHits;
    },
    get cacheMisses() {
      return cacheMisses;
    },
    resetCacheStats() {
      cacheHits = 0;
      cacheMisses = 0;
    },
  };
}
