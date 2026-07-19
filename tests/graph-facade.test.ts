/**
 * Facade wiring for optional graph — no native kuzu required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  GraphCheckpointNotSupportedError,
  ProviderNotConfiguredError,
  wolbarg,
} from "../src/index.js";
import { validateTelemetryConfig, validateWolbargOptions } from "../src/core/validate.js";
import { InMemoryKuzuSemanticsGraph } from "./in-memory-kuzu-semantics.js";
import { installFetchMock } from "./helpers.js";

describe("graph facade", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("linkMemories / getRelated throw when graph not configured", async () => {
    installFetchMock();
    const ctx = wolbarg({
      organization: "g",
      storage: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
    });
    await ctx.ready();
    await expect(ctx.linkMemories("a", "b", "r")).rejects.toThrow(
      ProviderNotConfiguredError,
    );
    await expect(ctx.getRelated("a")).rejects.toThrow(ProviderNotConfiguredError);
    await ctx.close();
  });

  it("linkMemories + getRelated + forget cascade with stand-in graph", async () => {
    installFetchMock();
    const graph = new InMemoryKuzuSemanticsGraph();
    const ctx = wolbarg({
      organization: "g",
      storage: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "m",
      },
      graph,
    });
    await ctx.ready();
    const a = await ctx.remember({
      agent: "bot",
      content: { text: "alpha memory" },
    });
    const b = await ctx.remember({
      agent: "bot",
      content: { text: "beta memory" },
    });
    await ctx.linkMemories(a.id, b.id, "related");
    const related = await ctx.getRelated(a.id);
    expect(related.map((r) => r.id)).toEqual([b.id]);

    const hits = await ctx.recall({
      query: "alpha",
      topK: 5,
      includeGraph: true,
    });
    const withGraph = hits.find((h) => h.id === a.id);
    expect(withGraph?.related?.some((r) => r.id === b.id)).toBe(true);

    await ctx.forget({ id: b.id });
    expect(await ctx.getRelated(a.id)).toEqual([]);
    await ctx.close();
  });

  it("Neo4j checkpoint throws typed error", async () => {
    installFetchMock();
    vi.doMock("neo4j-driver", () => ({
      auth: { basic: () => ({}) },
      driver: () => ({
        verifyConnectivity: async () => undefined,
        close: async () => undefined,
        session: () => ({
          run: async () => ({ records: [] }),
          close: async () => undefined,
        }),
      }),
    }));
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-graph-ck-"));
    const dbPath = path.join(dir, "memory.db");
    const graph = new Neo4jGraphProvider({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "test",
    });
    const ctx = wolbarg({
      organization: "g",
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
    await expect(ctx.checkpoint("snap1")).rejects.toThrow(
      GraphCheckpointNotSupportedError,
    );
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("neo4j-driver");
  });

  it("rejects garbage graph config", () => {
    expect(() =>
      validateWolbargOptions({
        organization: "g",
        storage: { provider: "sqlite", connectionString: ":memory:" },
        embedding: {
          baseUrl: "https://embed.test/v1",
          apiKey: "k",
          model: "m",
        },
        graph: { provider: "redis" } as never,
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects kuzu/neo4j as telemetry backends", () => {
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
});
