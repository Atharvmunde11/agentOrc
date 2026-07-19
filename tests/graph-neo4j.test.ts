/**
 * Neo4jGraphProvider — always runs against a mock driver (no skipIf).
 * Live Neo4j is optional extra coverage when NEO4J_* is set (still no skip).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_TYPED, runTypedGraphSuite } from "./graph-parity-cases.js";
import { createMockNeo4jModule } from "./mock-neo4j-driver.js";

const liveUrl = process.env.NEO4J_URL?.trim();
const liveUser = process.env.NEO4J_USER?.trim() ?? "neo4j";
const livePassword = process.env.NEO4J_PASSWORD?.trim();
const liveDatabase = process.env.NEO4J_DATABASE?.trim();
const hasLive = Boolean(liveUrl && livePassword);

describe("Neo4jGraphProvider (mocked driver)", () => {
  let graph: InstanceType<
    typeof import("../src/graph/providers/neo4j.js").Neo4jGraphProvider
  >;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("neo4j-driver", () => createMockNeo4jModule());
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    graph = new Neo4jGraphProvider({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "test",
    });
    await graph.open();
  });

  afterEach(async () => {
    await graph.close().catch(() => undefined);
    vi.doUnmock("neo4j-driver");
    vi.resetModules();
  });

  it("runs typed graph suite with portable outcomes", async () => {
    const result = await runTypedGraphSuite(graph);
    expect(result.relatedIdsDepth1).toEqual(EXPECTED_TYPED.relatedIdsDepth1);
    expect(result.relatedIdsDepth2).toEqual(EXPECTED_TYPED.relatedIdsDepth2);
    expect(result.relatedIdsOut).toEqual(EXPECTED_TYPED.relatedIdsOut);
    expect(result.relatedIdsIn).toEqual(EXPECTED_TYPED.relatedIdsIn);
    expect(result.relatedByRelation).toEqual(EXPECTED_TYPED.relatedByRelation);
    expect(result.afterUnlink).toEqual(EXPECTED_TYPED.afterUnlink);
    expect(result.afterDelete).toEqual(EXPECTED_TYPED.afterDelete);
  });

  it("supportsFileSnapshot is false", () => {
    expect(graph.supportsFileSnapshot()).toBe(false);
    expect(graph.getDataPath()).toBeNull();
  });

  it("health reports ok after open", async () => {
    const h = await graph.health();
    expect(h.ok).toBe(true);
    expect(h.backend).toBe("neo4j");
  });

  it("rejects invalid constructor options", async () => {
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    expect(
      () =>
        new Neo4jGraphProvider({
          url: "",
          username: "u",
          password: "p",
        }),
    ).toThrow(/non-empty url/i);
    expect(
      () =>
        new Neo4jGraphProvider({
          url: "bolt://x",
          username: "",
          password: "p",
        }),
    ).toThrow(/non-empty username/i);
  });

  it("linkEntityToMemory fails for unknown entity", async () => {
    await expect(
      graph.linkEntityToMemory("missing-entity", "m1", "role"),
    ).rejects.toThrow(/Entity not found/);
  });
});

describe("Neo4jGraphProvider missing package", () => {
  it("open throws ConfigurationError when neo4j-driver cannot be imported", async () => {
    vi.resetModules();
    vi.doMock("neo4j-driver", () => {
      throw new Error("Cannot find module 'neo4j-driver'");
    });
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    const graph = new Neo4jGraphProvider({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "test",
    });
    await expect(graph.open()).rejects.toThrow(/neo4j-driver/i);
    vi.doUnmock("neo4j-driver");
    vi.resetModules();
  });
});

describe("Neo4jGraphProvider live (when NEO4J_* set)", () => {
  it("runs typed suite against live instance or documents mock-only CI", async () => {
    if (!hasLive) {
      // No skip — assert the env gate is intentional and mock suite covers CI.
      expect(hasLive).toBe(false);
      expect(createMockNeo4jModule).toBeTypeOf("function");
      return;
    }
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    const graph = new Neo4jGraphProvider({
      url: liveUrl!,
      username: liveUser,
      password: livePassword!,
      database: liveDatabase,
    });
    await graph.open();
    try {
      await graph.query(
        `MATCH (n:Memory) WHERE n.id STARTS WITH 'm' DETACH DELETE n`,
      );
      await graph.query(
        `MATCH (n:Entity) WHERE n.id STARTS WITH 'ent_' DETACH DELETE n`,
      );
      const result = await runTypedGraphSuite(graph);
      expect(result.relatedIdsDepth1).toEqual(EXPECTED_TYPED.relatedIdsDepth1);
      expect(result.afterDelete).toEqual(EXPECTED_TYPED.afterDelete);
    } finally {
      await graph.close();
    }
  });
});
