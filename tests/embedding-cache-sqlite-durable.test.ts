import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CREATE_EMBEDDING_CACHE_INDEX,
  CREATE_EMBEDDING_CACHE_TABLE,
  SqliteEmbeddingCacheStore,
} from "../src/embedding/cache-store.js";
import { embeddingCacheKey } from "../src/embedding/cache.js";

function createTempSqlitePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-"));
  return path.join(dir, "cache.db");
}

describe("SqliteEmbeddingCacheStore durability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads durable L2 cache entries after restart", async () => {
    const dbPath = createTempSqlitePath();
    const model = "m";
    const key = embeddingCacheKey("hello world", model);
    const vector = Float32Array.from([1, 2, 3, 4]);

    let db = new DatabaseSync(dbPath, { allowExtension: true });
    db.exec(CREATE_EMBEDDING_CACHE_TABLE);
    db.exec(CREATE_EMBEDDING_CACHE_INDEX);

    const store1 = new SqliteEmbeddingCacheStore(() => db, { ttlMs: null });
    await store1.set(key, model, vector);
    await store1.flushTouches();
    db.close();

    db = new DatabaseSync(dbPath, { allowExtension: true });
    const store2 = new SqliteEmbeddingCacheStore(() => db, { ttlMs: null });
    const out = await store2.get(key);
    db.close();

    expect(out).not.toBeNull();
    expect(out ? Array.from(out) : null).toEqual(Array.from(vector));
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("re-queues failed durable flush instead of dropping entries", async () => {
    const dbPath = createTempSqlitePath();
    const model = "m";
    const key = embeddingCacheKey("requeue test", model);
    const vector = Float32Array.from([0.1, 0.2, 0.3, 0.4]);

    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.exec(CREATE_EMBEDDING_CACHE_TABLE);
    db.exec(CREATE_EMBEDDING_CACHE_INDEX);

    const originalExec = db.exec.bind(db);
    let commitCalls = 0;
    (db as any).exec = (sql: string) => {
      if (sql === "COMMIT" && commitCalls === 0) {
        commitCalls += 1;
        throw new Error("simulated COMMIT failure");
      }
      return originalExec(sql);
    };

    const store1 = new SqliteEmbeddingCacheStore(() => db, { ttlMs: null });
    await store1.set(key, model, vector);
    await store1.flushTouches();
    db.close();

    // Wait for the scheduled retry flush.
    await new Promise((r) => setTimeout(r, 20));

    const db2 = new DatabaseSync(dbPath, { allowExtension: true });
    const store2 = new SqliteEmbeddingCacheStore(() => db2, { ttlMs: null });
    const out = await store2.get(key);
    db2.close();

    expect(out).not.toBeNull();
    expect(out ? Array.from(out) : null).toEqual(Array.from(vector));

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

