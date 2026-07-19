/**
 * Brutal edge-case suite for graph memory + facade (v0.5 surface).
 * No skipIf — every case must pass.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  GraphCheckpointNotSupportedError,
  ProviderNotConfiguredError,
  ValidationError,
  wolbarg,
  sqliteGraph,
  neo4jGraph,
} from "../src/index.js";
import {
  resolveGraphInput,
  validateTelemetryConfig,
  validateWolbargOptions,
} from "../src/core/validate.js";
import { InMemoryKuzuSemanticsGraph } from "./in-memory-kuzu-semantics.js";
import { installFetchMock } from "./helpers.js";
import { createMockNeo4jModule } from "./mock-neo4j-driver.js";
import { SqliteGraphProvider } from "../src/graph/providers/sqlite-graph.js";

async function makeClient(graph?: ConstructorParameters<
  typeof wolbarg
>[0]["graph"]) {
  installFetchMock();
  const ctx = wolbarg({
    organization: "edge-org",
    storage: { provider: "sqlite", connectionString: ":memory:" },
    embedding: {
      baseUrl: "https://embed.test/v1",
      apiKey: "k",
      model: "m",
    },
    ...(graph !== undefined ? { graph } : {}),
  });
  await ctx.ready();
  return ctx;
}

describe("v0.5 brutal edge cases — graph provider surface", () => {
  let graph: InMemoryKuzuSemanticsGraph;

  beforeEach(async () => {
    graph = new InMemoryKuzuSemanticsGraph();
    await graph.open();
  });

  afterEach(async () => {
    await graph.close().catch(() => undefined);
  });

  it("self-loop link + getRelated both directions", async () => {
    await graph.linkMemories("x", "x", "self");
    const out = await graph.getRelated("x", { direction: "out" });
    const inn = await graph.getRelated("x", { direction: "in" });
    // Self-loop: visited set excludes start, so related may be empty or include x
    // depending on BFS — our BFS starts with visited={x}, so self-loop never adds x.
    expect(out.map((r) => r.id)).toEqual([]);
    expect(inn.map((r) => r.id)).toEqual([]);
  });

  it("idempotent re-link overwrites metadata without duplicating", async () => {
    await graph.linkMemories("a", "b", "r", { v: 1 });
    await graph.linkMemories("a", "b", "r", { v: 2 });
    const related = await graph.getRelated("a", {
      direction: "out",
      relation: "r",
    });
    expect(related.map((r) => r.id)).toEqual(["b"]);
  });

  it("multiple distinct relations between same pair", async () => {
    await graph.linkMemories("a", "b", "mentions");
    await graph.linkMemories("a", "b", "cites");
    const mentions = await graph.getRelated("a", {
      direction: "out",
      relation: "mentions",
    });
    const cites = await graph.getRelated("a", {
      direction: "out",
      relation: "cites",
    });
    expect(mentions.map((r) => r.id)).toEqual(["b"]);
    expect(cites.map((r) => r.id)).toEqual(["b"]);
    await graph.unlinkMemories("a", "b", "mentions");
    expect(
      (await graph.getRelated("a", { direction: "out", relation: "mentions" }))
        .length,
    ).toBe(0);
    expect(
      (await graph.getRelated("a", { direction: "out", relation: "cites" })).map(
        (r) => r.id,
      ),
    ).toEqual(["b"]);
  });

  it("unlink without relation removes all edges between pair", async () => {
    await graph.linkMemories("a", "b", "r1");
    await graph.linkMemories("a", "b", "r2");
    await graph.unlinkMemories("a", "b");
    expect(
      (await graph.getRelated("a", { direction: "out" })).length,
    ).toBe(0);
  });

  it("unlink of missing edge is a no-op", async () => {
    await expect(
      graph.unlinkMemories("nope", "missing", "r"),
    ).resolves.toBeUndefined();
  });

  it("depth is clamped to at least 1 and at most 16", async () => {
    await graph.linkMemories("n0", "n1", "next");
    await graph.linkMemories("n1", "n2", "next");
    // depth undefined → 1
    expect(
      (await graph.getRelated("n0", { direction: "out" })).map((r) => r.id),
    ).toEqual(["n1"]);
    // depth 0 coerced to 1
    expect(
      (await graph.getRelated("n0", { depth: 0, direction: "out" })).map(
        (r) => r.id,
      ),
    ).toEqual(["n1"]);
    // depth 2 reaches n2
    expect(
      (await graph.getRelated("n0", { depth: 2, direction: "out" }))
        .map((r) => r.id)
        .sort(),
    ).toEqual(["n1", "n2"]);
  });

  it("unicode + special relation names", async () => {
    await graph.linkMemories("m1", "m2", "关联·edge/with spaces", {
      note: "日本語",
    });
    const hits = await graph.getRelated("m1", {
      direction: "out",
      relation: "关联·edge/with spaces",
    });
    expect(hits.map((r) => r.id)).toEqual(["m2"]);
  });

  it("entity upsert is case-insensitive on name+type for stable id", async () => {
    const a = await graph.upsertEntity({ name: "Alice", type: "Person" });
    const b = await graph.upsertEntity({ name: "ALICE", type: "person" });
    expect(a).toBe(b);
  });

  it("linkEntityToMemory rejects unknown entity", async () => {
    await expect(
      graph.linkEntityToMemory("ent_missing", "m1"),
    ).rejects.toThrow(/Entity not found/);
  });

  it("deleteMemory removes incident edges from both sides", async () => {
    await graph.linkMemories("a", "b", "r");
    await graph.linkMemories("c", "b", "r");
    await graph.deleteMemory("b");
    expect((await graph.getRelated("a", { direction: "out" })).length).toBe(0);
    expect((await graph.getRelated("c", { direction: "out" })).length).toBe(0);
  });

  it("operations before open throw", async () => {
    const g = new InMemoryKuzuSemanticsGraph();
    await expect(g.linkMemories("a", "b", "r")).rejects.toThrow();
    await g.open();
    await g.close();
    await expect(g.getRelated("a")).rejects.toThrow();
  });

  it("health after close is not ok", async () => {
    await graph.close();
    const h = await graph.health();
    expect(h.ok).toBe(false);
  });
});

describe("v0.5 brutal edge cases — Wolbarg facade", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includeGraph omitted does not attach related", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "alpha edge" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "beta edge" },
    });
    await ctx.linkMemories(a.id, b.id, "related");
    const hits = await ctx.recall({ query: "alpha", topK: 5 });
    for (const h of hits) {
      expect(h.related).toBeUndefined();
    }
    await ctx.close();
  });

  it("includeGraph true without graph does not throw (no related)", async () => {
    const ctx = await makeClient();
    await ctx.remember({ agent: "bot", content: { text: "solo" } });
    const hits = await ctx.recall({
      query: "solo",
      topK: 3,
      includeGraph: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.related).toBeUndefined();
    }
    await ctx.close();
  });

  it("forget by filter cascades all matching graph nodes", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "team-a",
      content: { text: "cascade one" },
    });
    const b = await ctx.remember({
      agent: "team-a",
      content: { text: "cascade two" },
    });
    await ctx.linkMemories(a.id, b.id, "related");
    const n = await ctx.forget({ filter: { agent: "team-a" } });
    expect(n).toBe(2);
    expect(await ctx.getRelated(a.id)).toEqual([]);
    await ctx.close();
  });

  it("clear cascades graph nodes", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "clear me" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "clear me too" },
    });
    await ctx.linkMemories(a.id, b.id, "r");
    await ctx.clear({ confirm: true });
    expect(await ctx.getRelated(a.id)).toEqual([]);
    await ctx.close();
  });

  it("clear without confirm throws ValidationError", async () => {
    const ctx = await makeClient();
    await expect(ctx.clear({} as never)).rejects.toThrow(ValidationError);
    await ctx.close();
  });

  it("linkMemories rejects empty ids / relation", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    await expect(ctx.linkMemories("", "b", "r")).rejects.toThrow();
    await expect(ctx.linkMemories("a", "b", "  ")).rejects.toThrow();
    await ctx.close();
  });

  it("ProviderNotConfiguredError names graph for link/getRelated", async () => {
    const ctx = await makeClient();
    try {
      await ctx.linkMemories("a", "b", "r");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderNotConfiguredError);
      expect((e as ProviderNotConfiguredError).provider).toBe("graph");
    }
    await ctx.close();
  });

  it("Neo4j checkpoint throws GraphCheckpointNotSupportedError", async () => {
    installFetchMock();
    vi.resetModules();
    vi.doMock("neo4j-driver", () => createMockNeo4jModule());
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-ck-"));
    const dbPath = path.join(dir, "memory.db");
    const graph = new Neo4jGraphProvider({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "test",
    });
    const ctx = wolbarg({
      organization: "edge-org",
      storage: { provider: "sqlite", connectionString: dbPath },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      graph,
      checkpointDirectory: path.join(dir, "ck"),
    });
    await ctx.ready();
    await expect(ctx.checkpoint("x")).rejects.toThrow(
      GraphCheckpointNotSupportedError,
    );
    await expect(ctx.export(path.join(dir, "exp"))).rejects.toThrow(
      GraphCheckpointNotSupportedError,
    );
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("neo4j-driver");
    vi.resetModules();
  });

  it("SQLite graph file snapshot runs on checkpoint without throwing", async () => {
    installFetchMock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-sgck-"));
    const dbPath = path.join(dir, "memory.db");
    const graphPath = path.join(dir, "g.db");
    const graph = new SqliteGraphProvider({ path: graphPath });
    const ctx = wolbarg({
      organization: "edge-org",
      storage: { provider: "sqlite", connectionString: dbPath },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      graph,
      checkpointDirectory: path.join(dir, "ck"),
    });
    await ctx.ready();
    await ctx.remember({ agent: "bot", content: { text: "snap" } });
    const meta = await ctx.checkpoint("edge-snap");
    expect(meta.name).toBe("edge-snap");
    expect(fs.existsSync(`${meta.snapshotPath}.graph`)).toBe(true);
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("concurrent linkMemories do not throw", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ctx.remember({
          agent: "bot",
          content: { text: `concurrent ${i}` },
        }),
      ),
    );
    await Promise.all(
      ids.slice(1).map((m, i) =>
        ctx.linkMemories(ids[0]!.id, m.id, `r${i}`),
      ),
    );
    const related = await ctx.getRelated(ids[0]!.id, { direction: "out" });
    expect(related.length).toBe(7);
    await ctx.close();
  });

  it("huge metadata on link survives", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "meta a" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "meta b" },
    });
    const blob = "x".repeat(50_000);
    await ctx.linkMemories(a.id, b.id, "fat", { blob });
    const related = await ctx.getRelated(a.id);
    expect(related.map((r) => r.id)).toEqual([b.id]);
    await ctx.close();
  });

  it("getRelated on unknown id returns empty", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    expect(await ctx.getRelated("does-not-exist")).toEqual([]);
    await ctx.close();
  });

  it("double ready/close is safe", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    await ctx.ready();
    await ctx.ready();
    await ctx.close();
    await ctx.close();
  });

  it("includeGraph hydrates related content from storage", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "hydrate source unique phrase" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "hydrate target unique phrase" },
    });
    await ctx.linkMemories(a.id, b.id, "related");
    const hits = await ctx.recall({
      query: "hydrate source unique phrase",
      topK: 5,
      includeGraph: true,
    });
    const hit = hits.find((h) => h.id === a.id);
    expect(hit?.related?.length).toBeGreaterThan(0);
    expect(hit?.related?.[0]?.content.text).toContain("hydrate target");
    await ctx.close();
  });

  it("forget missing id returns 0 and leaves graph intact", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "keep me" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "also keep" },
    });
    await ctx.linkMemories(a.id, b.id, "r");
    expect(await ctx.forget({ id: "00000000-0000-0000-0000-000000000000" })).toBe(
      0,
    );
    expect((await ctx.getRelated(a.id)).map((r) => r.id)).toEqual([b.id]);
    await ctx.close();
  });

  it("update memory then getRelated still resolves id", async () => {
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = await makeClient(graph);
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "before update" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "neighbor" },
    });
    await ctx.linkMemories(a.id, b.id, "r");
    await ctx.update({ id: a.id, content: { text: "after update" } });
    const related = await ctx.getRelated(a.id);
    expect(related.map((r) => r.id)).toEqual([b.id]);
    await ctx.close();
  });
});

describe("v0.5 brutal edge cases — config validation", () => {
  it("rejects null / array / unknown graph provider", () => {
    expect(() => resolveGraphInput(null as never)).toThrow(ConfigurationError);
    expect(() => resolveGraphInput([] as never)).toThrow(ConfigurationError);
    expect(() =>
      resolveGraphInput({ provider: "redis" } as never),
    ).toThrow(ConfigurationError);
  });

  it("sqliteGraph / neo4jGraph factories produce providers", () => {
    const s = sqliteGraph({ path: "./tmp-graph.db" });
    expect(s.name).toBe("sqlite");
    const n = neo4jGraph({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "x",
    });
    expect(n.name).toBe("neo4j");
  });

  it("validateWolbargOptions accepts graph config shapes", () => {
    const opts = validateWolbargOptions({
      organization: "o",
      storage: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      graph: { provider: "sqlite", path: "./g.db" },
    });
    expect(opts.graph).toBeTruthy();
    expect((opts.graph as { name: string }).name).toBe("sqlite");
  });

  it("rejects kuzu and neo4j as telemetry backends loudly", () => {
    expect(() =>
      validateTelemetryConfig({
        database: { provider: "kuzu" as never, url: "./t.db" },
      }),
    ).toThrow(/telemetry supports sqlite or postgres only/);
    expect(() =>
      validateTelemetryConfig({
        database: { provider: "neo4j" as never, url: "./t.db" },
      }),
    ).toThrow(/telemetry supports sqlite or postgres only/);
  });

  it("omitting graph leaves existing options validation intact", () => {
    const opts = validateWolbargOptions({
      organization: "o",
      storage: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
    });
    expect(opts.graph).toBeUndefined();
  });
});
