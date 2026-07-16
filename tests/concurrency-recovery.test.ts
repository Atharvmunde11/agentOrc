import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wolbarg } from "../src/index.js";
import { baseInitOptions, installFetchMock } from "./helpers.js";

describe("concurrency + crash recovery + empty database", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports empty database stats", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions());
    const stats = await ctx.stats();
    expect(stats.totalMemories).toBe(0);
    expect(stats.totalAgents).toBe(0);
    expect(stats.databaseSizeBytes).toBeGreaterThanOrEqual(0);
    await ctx.close();
  });

  it("handles concurrent writes safely", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions());

    const writes = Array.from({ length: 20 }, (_, i) =>
      ctx.remember({
        agent: i % 2 === 0 ? "alpha" : "beta",
        content: { text: `Concurrent memory number ${i}` },
        metadata: { i },
      }),
    );

    const results = await Promise.all(writes);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(20);

    const stats = await ctx.stats();
    expect(stats.totalMemories).toBe(20);
    expect(stats.totalAgents).toBe(2);

    await ctx.close();
  });

  it("recovers data after reopen (crash-safe WAL writes)", async () => {
    installFetchMock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Wolbarg-"));
    const dbPath = path.join(dir, "memory.db");

    const ctx1 = new Wolbarg();
    await ctx1.init(
      baseInitOptions({
        database: { provider: "sqlite", connectionString: dbPath },
      }),
    );

    const stored = await ctx1.remember({
      agent: "research",
      content: { text: "Persisted across reopen." },
      metadata: { durable: true },
    });
    await ctx1.close();

    // Simulate process restart
    const ctx2 = new Wolbarg();
    await ctx2.init(
      baseInitOptions({
        database: { provider: "sqlite", connectionString: dbPath },
      }),
    );

    const history = await ctx2.history({ id: stored.id });
    expect(history.memory.content.text).toBe("Persisted across reopen.");
    expect(history.memory.metadata).toEqual({ durable: true });

    const recalled = await ctx2.recall({
      query: "Persisted across reopen.",
      topK: 1,
    });
    expect(recalled[0]?.id).toBe(stored.id);

    await ctx2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
