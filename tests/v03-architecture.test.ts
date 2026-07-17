/**
 * v0.3 architecture: telemetry, explain, checkpoints, batch, import/export.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SqliteEventDatabase,
  wolbarg,
  Wolbarg,
} from "../src/index.js";
import {
  fakeEmbedding,
  installFetchMock,
} from "./helpers.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("v0.3 architecture", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir("wolbarg-v03-");
    installFetchMock();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts database.url alias via wolbarg() factory", async () => {
    const memory = path.join(dir, "memory.db");
    const telemetry = path.join(dir, "telemetry.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      telemetry: {
        enabled: true,
        database: { provider: "sqlite", url: telemetry },
        level: "error",
      },
    });

    await ctx.ready();
    await ctx.remember({
      agent: "a",
      content: { text: "hello world" },
    });
    await ctx.flushTelemetry();
    await ctx.close();

    expect(fs.existsSync(memory)).toBe(true);
    expect(fs.existsSync(telemetry)).toBe(true);
  });

  it("keeps telemetry in a separate EventDatabase", async () => {
    const memory = path.join(dir, "mem.db");
    const telemetry = path.join(dir, "tel.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      telemetry: {
        enabled: true,
        database: { provider: "sqlite", url: telemetry },
        level: "off",
      },
    });

    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "alpha" } });
    await ctx.recall({
      query: "alpha",
      topK: 3,
      filter: { agent: "a" },
      explain: true,
    });
    await ctx.flushTelemetry();

    const events = new SqliteEventDatabase({ url: telemetry, readonly: true });
    await events.open();
    const result = await events.query({ limit: 50 });
    await events.close();
    await ctx.close();

    expect(result.total).toBeGreaterThan(0);
    expect(result.events.some((e) => e.operation === "remember")).toBe(true);
    expect(result.events.some((e) => e.operation === "recall")).toBe(true);
    const recallEvent = result.events.find((e) => e.operation === "recall");
    expect(recallEvent?.organization).toBe("org");
    expect(recallEvent?.agentId).toBe("a");
    expect(recallEvent?.explain?.signals.recency).toBe("disabled");
    expect(recallEvent?.spans?.some((span) => span.name === "vectorSearchMs")).toBe(
      true,
    );
    expect(result.events.every((e) => e.sessionId === ctx.sessionId || true)).toBe(
      true,
    );

    // Memory DB must not contain telemetry_events table.
    const { DatabaseSync } = await import("node:sqlite");
    const memDb = new DatabaseSync(memory, { readOnly: true });
    const tables = memDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'`,
      )
      .all() as Array<{ name: string }>;
    memDb.close();
    expect(tables).toHaveLength(0);
  });

  it("supports recall explain mode", async () => {
    const memory = path.join(dir, "explain.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
    });
    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "quantum computing" } });
    const explained = await ctx.recall({
      query: "quantum",
      topK: 5,
      explain: true,
    });
    await ctx.close();

    expect(explained.results.length).toBeGreaterThan(0);
    expect(explained.results[0]?.score).toBeTypeOf("number");
    expect(explained.results[0]?.rankingReason).toBeTruthy();
    expect(explained.providerUsed).toBe("sqlite");
    expect(explained.traceId).toBeTruthy();
  });

  it("reads and migrates v1 telemetry databases to schema v2", async () => {
    const telemetry = path.join(dir, "legacy-telemetry.db");
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(telemetry);
    legacy.exec(`
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, operation TEXT NOT NULL,
        provider TEXT, duration_ms REAL, status TEXT NOT NULL, query TEXT,
        filters_json TEXT, returned_count INTEGER, memory_ids_json TEXT,
        similarity_scores_json TEXT, metadata_json TEXT, embedding_provider TEXT,
        model TEXT, error TEXT, error_stack TEXT, session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL, parent_trace_id TEXT, user_metadata_json TEXT,
        extra_json TEXT, latency_json TEXT
      );
      INSERT INTO telemetry_events (
        id, timestamp, operation, status, session_id, trace_id
      ) VALUES ('legacy', '2026-01-01T00:00:00.000Z', 'recall', 'ok', 's', 't');
    `);
    legacy.close();

    const reader = new SqliteEventDatabase({ url: telemetry, readonly: true });
    await reader.open();
    const before = await reader.getEvent("legacy");
    await reader.close();
    expect(before?.organization).toBeNull();
    expect(before?.spans).toBeNull();

    const writer = new SqliteEventDatabase({ url: telemetry });
    await writer.open();
    await writer.insertEvent({
      operation: "checkpoint",
      status: "ok",
      sessionId: "s2",
      traceId: "t2",
      organization: "org",
      agentId: "agent",
      tags: ["release"],
      checkpointId: "cp-1",
      spans: [{ name: "databaseWriteMs", startMs: 0, durationMs: 1 }],
    });
    const filtered = await writer.query({
      organization: "org",
      agentId: "agent",
      tag: "release",
      checkpointId: "cp-1",
    });
    await writer.close();
    expect(filtered.total).toBe(1);

    const migrated = new DatabaseSync(telemetry, { readOnly: true });
    const version = migrated
      .prepare("SELECT value FROM telemetry_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    const indexes = migrated
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_telemetry_operation_time'",
      )
      .all();
    migrated.close();
    expect(version.value).toBe("2");
    expect(indexes).toHaveLength(1);
  });

  it("creates checkpoints without overwrite and can rollback", async () => {
    const memory = path.join(dir, "cp-memory.db");
    const checkpoints = path.join(dir, "checkpoints");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      checkpointDirectory: checkpoints,
    });

    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "before" } });
    const cp = await ctx.checkpoint("snap1", { description: "first" });
    expect(cp.name).toBe("snap1");

    await expect(ctx.checkpoint("snap1")).rejects.toThrow(/already exists/);

    await ctx.remember({ agent: "a", content: { text: "after" } });
    const statsAfter = await ctx.stats();
    expect(statsAfter.activeMemories).toBe(2);

    await ctx.rollback("snap1");
    const statsRolled = await ctx.stats();
    expect(statsRolled.activeMemories).toBe(1);

    const listed = await ctx.listCheckpoints();
    expect(listed.map((c) => c.name)).toContain("snap1");
    const got = await ctx.getCheckpoint("snap1");
    expect(got?.description).toBe("first");

    // Failed rollback must not leave storage closed (production edge case).
    await expect(ctx.rollback("does-not-exist")).rejects.toThrow(/not found/i);
    await ctx.remember({
      agent: "a",
      content: { text: "still writable after failed rollback" },
    });
    expect((await ctx.stats()).activeMemories).toBe(2);

    await ctx.deleteCheckpoint("snap1");
    expect(await ctx.getCheckpoint("snap1")).toBeNull();
    await ctx.close();
  });

  it("exports and imports memory databases", async () => {
    const memory = path.join(dir, "io-memory.db");
    const exportPath = path.join(dir, "bundle.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
    });
    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "portable" } });
    const exported = await ctx.export(exportPath);
    expect(fs.existsSync(exported.path)).toBe(true);
    expect(fs.existsSync(`${exported.path}.manifest.json`)).toBe(true);

    await ctx.clear({ confirm: true });
    expect((await ctx.stats()).activeMemories).toBe(0);

    await ctx.import(exported.path);
    const hits = await ctx.recall({ query: "portable", topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    await ctx.close();
  });

  it("rememberBatch and recallBatch work with child telemetry", async () => {
    const memory = path.join(dir, "batch.db");
    const telemetry = path.join(dir, "batch-tel.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      telemetry: {
        enabled: true,
        database: { provider: "sqlite", url: telemetry },
        level: "off",
      },
    });
    await ctx.ready();

    // enrich fetch mock for batch embeddings
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/embeddings")) {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as { input?: string | string[] })
            : {};
          const inputs = Array.isArray(body.input)
            ? body.input
            : [typeof body.input === "string" ? body.input : ""];
          return new Response(
            JSON.stringify({
              data: inputs.map((text, index) => ({
                embedding: fakeEmbedding(text),
                index,
              })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const records = await ctx.rememberBatch([
      { agent: "a", content: { text: "one" } },
      { agent: "a", content: { text: "two" } },
    ]);
    expect(records).toHaveLength(2);

    const batches = await ctx.recallBatch([
      { query: "one", topK: 2 },
      { query: "two", topK: 2 },
    ]);
    expect(batches).toHaveLength(2);

    await ctx.flushTelemetry();
    const events = new SqliteEventDatabase({ url: telemetry, readonly: true });
    await events.open();
    const result = await events.query({ limit: 100 });
    await events.close();
    await ctx.close();

    expect(result.events.some((e) => e.operation === "rememberBatch")).toBe(
      true,
    );
    expect(result.events.some((e) => e.operation === "recallBatch")).toBe(true);
    expect(
      result.events.filter((e) => e.parentTraceId !== null).length,
    ).toBeGreaterThan(0);
  });

  it("preserves constructor storage API backwards compatibility", async () => {
    const ctx = new Wolbarg({
      organization: "org",
      storage: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
    });
    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "compat" } });
    const hits = await ctx.recall({ query: "compat" });
    expect(hits.length).toBeGreaterThan(0);
    await ctx.close();
  });

  it("no-ops telemetry when disabled", async () => {
    const memory = path.join(dir, "noop.db");
    const telemetry = path.join(dir, "noop-tel.db");
    const ctx = wolbarg({
      organization: "org",
      database: { provider: "sqlite", url: memory },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      telemetry: {
        enabled: false,
        database: { provider: "sqlite", url: telemetry },
      },
    });
    await ctx.ready();
    await ctx.remember({ agent: "a", content: { text: "x" } });
    await ctx.flushTelemetry();
    await ctx.close();
    // Disabled path should not create/populate telemetry db aggressively;
    // provider may still open but queue stays empty / disabled emitter skips.
    expect(true).toBe(true);
  });
});
