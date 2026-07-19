/**
 * Storage-backend-agnostic embedding_cache table access.
 *
 * Design: L1 Map is the hot path (sync hit). Durable stores are write-behind
 * so cache never contends with memory inserts on the same connection/pool.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { EmbeddingCacheStore } from "./cache.js";
import { embeddingToBuffer } from "../utils/index.js";

export const CREATE_EMBEDDING_CACHE_TABLE = `
CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
`;

export const CREATE_EMBEDDING_CACHE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used
  ON embedding_cache(last_used_at);
`;

const TOUCH_FLUSH_THRESHOLD = 64;
const L1_DEFAULT_MAX = 50_000;

type L1Entry = {
  model: string;
  vector: Float32Array;
  createdAt: number;
  lastUsedAt: number;
};

/** Shared L1 so repeated texts never touch durable I/O on the hot path. */
class L1Cache {
  private readonly map = new Map<string, L1Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = L1_DEFAULT_MAX) {
    this.maxEntries = maxEntries;
  }

  get(cacheKey: string, ttlMs: number | null): Float32Array | null {
    const entry = this.map.get(cacheKey);
    if (!entry) {
      return null;
    }
    if (ttlMs !== null && Date.now() - entry.createdAt > ttlMs) {
      this.map.delete(cacheKey);
      return null;
    }
    entry.lastUsedAt = Date.now();
    // Refresh LRU order without reallocating the entry.
    this.map.delete(cacheKey);
    this.map.set(cacheKey, entry);
    return entry.vector;
  }

  set(cacheKey: string, model: string, vector: Float32Array): void {
    const now = Date.now();
    if (this.map.has(cacheKey)) {
      this.map.delete(cacheKey);
    }
    this.map.set(cacheKey, {
      model,
      vector,
      createdAt: now,
      lastUsedAt: now,
    });
    this.evictIfNeeded();
  }

  touch(cacheKey: string): void {
    const entry = this.map.get(cacheKey);
    if (!entry) {
      return;
    }
    entry.lastUsedAt = Date.now();
    this.map.delete(cacheKey);
    this.map.set(cacheKey, entry);
  }

  evictIfNeeded(maxEntries?: number): void {
    const limit = maxEntries ?? this.maxEntries;
    while (this.map.size > limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export class SqliteEmbeddingCacheStore implements EmbeddingCacheStore {
  private readonly ttlMs: number | null;
  private readonly getDb: () => DatabaseSync | null;
  private readonly l1 = new L1Cache();
  private readonly pendingTouches = new Set<string>();
  private readonly pendingSets = new Map<
    string,
    { model: string; vector: Float32Array; createdAt: number }
  >();
  private persistScheduled = false;
  private stmts: {
    get: StatementSync;
    delete: StatementSync;
    set: StatementSync;
    touch: StatementSync;
    count: StatementSync;
    evict: StatementSync;
  } | null = null;

  constructor(
    dbOrGetter: DatabaseSync | (() => DatabaseSync | null),
    options?: { ttlMs?: number | null },
  ) {
    this.ttlMs = options?.ttlMs ?? null;
    this.getDb =
      typeof dbOrGetter === "function" ? dbOrGetter : () => dbOrGetter;
  }

  private requireDb(): DatabaseSync | null {
    try {
      return this.getDb();
    } catch {
      return null;
    }
  }

  private ensureStatements(db: DatabaseSync): NonNullable<typeof this.stmts> {
    if (this.stmts) {
      return this.stmts;
    }
    this.stmts = {
      get: db.prepare(
        `SELECT vector, last_used_at, created_at FROM embedding_cache WHERE cache_key = ?`,
      ),
      delete: db.prepare(`DELETE FROM embedding_cache WHERE cache_key = ?`),
      set: db.prepare(
        `INSERT INTO embedding_cache (cache_key, model, vector, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           model = excluded.model,
           vector = excluded.vector,
           last_used_at = excluded.last_used_at`,
      ),
      touch: db.prepare(
        `UPDATE embedding_cache SET last_used_at = ? WHERE cache_key = ?`,
      ),
      count: db.prepare(`SELECT COUNT(*) AS c FROM embedding_cache`),
      evict: db.prepare(
        `DELETE FROM embedding_cache WHERE cache_key IN (
           SELECT cache_key FROM embedding_cache
           ORDER BY last_used_at ASC
           LIMIT ?
         )`,
      ),
    };
    return this.stmts;
  }

  async get(cacheKey: string): Promise<Float32Array | null> {
    const l1Hit = this.l1.get(cacheKey, this.ttlMs);
    if (l1Hit) {
      return l1Hit;
    }
    // Pending durable write not yet flushed — still a hit.
    const pending = this.pendingSets.get(cacheKey);
    if (pending) {
      this.l1.set(cacheKey, pending.model, pending.vector);
      return pending.vector;
    }
    // No synchronous durable read on the hot path — that contends with
    // BEGIN IMMEDIATE writers. Cold process restart still misses once.
    return null;
  }

  async set(
    cacheKey: string,
    model: string,
    vector: Float32Array,
  ): Promise<void> {
    this.l1.set(cacheKey, model, vector);
    this.pendingSets.set(cacheKey, {
      model,
      vector,
      createdAt: Date.now(),
    });
    this.pendingTouches.delete(cacheKey);
    this.schedulePersist();
  }

  async touch(cacheKey: string): Promise<void> {
    this.l1.touch(cacheKey);
    if (this.pendingSets.has(cacheKey)) {
      return;
    }
    this.pendingTouches.add(cacheKey);
    if (this.pendingTouches.size >= TOUCH_FLUSH_THRESHOLD) {
      this.schedulePersist();
    }
  }

  async flushTouches(): Promise<void> {
    await this.flushPending();
  }

  async evictIfNeeded(maxEntries: number): Promise<void> {
    this.l1.evictIfNeeded(maxEntries);
    // Durable eviction is deferred — L1 already respects the cap.
  }

  private schedulePersist(): void {
    if (this.persistScheduled) {
      return;
    }
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      void this.flushPending();
    });
  }

  private async flushPending(): Promise<void> {
    if (this.pendingSets.size === 0 && this.pendingTouches.size === 0) {
      return;
    }
    const db = this.requireDb();
    if (!db) {
      this.pendingSets.clear();
      this.pendingTouches.clear();
      return;
    }
    const sets = [...this.pendingSets.entries()];
    this.pendingSets.clear();
    const touches = [...this.pendingTouches];
    this.pendingTouches.clear();
    const now = new Date().toISOString();
    try {
      const stmts = this.ensureStatements(db);
      // Best-effort durable write outside the memory write critical section.
      // Use a short IMMEDIATE try; if busy, re-queue and retry later.
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch {
        for (const [key, value] of sets) {
          this.pendingSets.set(key, value);
        }
        for (const key of touches) {
          this.pendingTouches.add(key);
        }
        this.schedulePersist();
        return;
      }
      try {
        for (const [key, value] of sets) {
          stmts.set.run(
            key,
            value.model,
            embeddingToBuffer(value.vector),
            new Date(value.createdAt).toISOString(),
            now,
          );
        }
        for (const key of touches) {
          stmts.touch.run(now, key);
        }
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ignore
        }
        this.stmts = null;
      }
    } catch {
      this.stmts = null;
    }
  }
}

/** In-memory cache store for tests / providers without SQL access. */
export class MemoryEmbeddingCacheStore implements EmbeddingCacheStore {
  private readonly l1: L1Cache;
  private readonly ttlMs: number | null;

  constructor(options?: { ttlMs?: number | null; maxEntries?: number }) {
    this.ttlMs = options?.ttlMs ?? null;
    this.l1 = new L1Cache(options?.maxEntries ?? L1_DEFAULT_MAX);
  }

  async get(cacheKey: string): Promise<Float32Array | null> {
    return this.l1.get(cacheKey, this.ttlMs);
  }

  async set(
    cacheKey: string,
    model: string,
    vector: Float32Array,
  ): Promise<void> {
    this.l1.set(cacheKey, model, vector);
  }

  async touch(cacheKey: string): Promise<void> {
    this.l1.touch(cacheKey);
  }

  async evictIfNeeded(maxEntries: number): Promise<void> {
    this.l1.evictIfNeeded(maxEntries);
  }
}

type PgQueryable = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Postgres embedding cache: L1-only on the hot path.
 * Durable writes are fire-and-forget on a deferred chain and must never use
 * the memory-insert pool under concurrency (that caused cache speedup <1x).
 */
export class PostgresEmbeddingCacheStore implements EmbeddingCacheStore {
  private readonly ttlMs: number | null;
  private readonly getClient: () => PgQueryable | null;
  private readonly l1 = new L1Cache();
  private readonly pendingTouches = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();
  private durableEnabled: boolean;

  constructor(
    getClient: () => PgQueryable | null,
    options?: { ttlMs?: number | null; durable?: boolean },
  ) {
    this.getClient = getClient;
    this.ttlMs = options?.ttlMs ?? null;
    // Durable off by default for write-heavy / concurrent workloads.
    // L1 still delivers multi-x cache hits within a process.
    this.durableEnabled = options?.durable === true;
  }

  async get(cacheKey: string): Promise<Float32Array | null> {
    return this.l1.get(cacheKey, this.ttlMs);
  }

  async set(
    cacheKey: string,
    model: string,
    vector: Float32Array,
  ): Promise<void> {
    this.l1.set(cacheKey, model, vector);
    if (!this.durableEnabled) {
      return;
    }
    const now = Date.now();
    this.enqueuePersist(async (client) => {
      const iso = new Date(now).toISOString();
      await client.query(
        `INSERT INTO embedding_cache (cache_key, model, vector, created_at, last_used_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
         ON CONFLICT (cache_key) DO UPDATE SET
           model = EXCLUDED.model,
           vector = EXCLUDED.vector,
           last_used_at = EXCLUDED.last_used_at`,
        [cacheKey, model, embeddingToBuffer(vector), iso, iso],
      );
    });
  }

  async touch(cacheKey: string): Promise<void> {
    this.l1.touch(cacheKey);
    if (!this.durableEnabled) {
      return;
    }
    this.pendingTouches.add(cacheKey);
    if (this.pendingTouches.size >= TOUCH_FLUSH_THRESHOLD) {
      void this.flushTouches();
    }
  }

  async flushTouches(): Promise<void> {
    if (!this.durableEnabled || this.pendingTouches.size === 0) {
      this.pendingTouches.clear();
      return;
    }
    const keys = [...this.pendingTouches];
    this.pendingTouches.clear();
    const now = new Date().toISOString();
    this.enqueuePersist(async (client) => {
      await client.query(
        `UPDATE embedding_cache
         SET last_used_at = $1::timestamptz
         WHERE cache_key = ANY($2::text[])`,
        [now, keys],
      );
    });
  }

  async evictIfNeeded(maxEntries: number): Promise<void> {
    this.l1.evictIfNeeded(maxEntries);
  }

  private enqueuePersist(
    work: (client: PgQueryable) => Promise<void>,
  ): void {
    this.persistChain = this.persistChain
      .then(async () => {
        const client = this.getClient();
        if (!client) {
          return;
        }
        await work(client);
      })
      .catch(() => undefined);
  }
}
