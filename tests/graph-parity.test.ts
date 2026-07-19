/**
 * Parity: SAME typed suite against SqliteGraphProvider and
 * Neo4jGraphProvider (mocked neo4j-driver). No skipIf — always runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphProvider } from "../src/graph/types.js";
import { SqliteGraphProvider } from "../src/graph/providers/sqlite-graph.js";
import { EXPECTED_TYPED, runTypedGraphSuite } from "./graph-parity-cases.js";
import { createMockNeo4jModule } from "./mock-neo4j-driver.js";

type BackendRun = {
  name: string;
  result: Awaited<ReturnType<typeof runTypedGraphSuite>>;
};

describe("graph typed-method parity (SQLite ↔ Neo4j)", () => {
  const runs: BackendRun[] = [];
  let sqliteDir: string | null = null;

  beforeAll(async () => {
    sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-parity-sqlite-"));
    const sqlite = new SqliteGraphProvider({
      path: path.join(sqliteDir, "parity-graph.db"),
    });
    await sqlite.open();
    try {
      runs.push({ name: "sqlite", result: await runTypedGraphSuite(sqlite) });
    } finally {
      await sqlite.close();
    }

    vi.resetModules();
    vi.doMock("neo4j-driver", () => createMockNeo4jModule());
    const { Neo4jGraphProvider } = await import(
      "../src/graph/providers/neo4j.js"
    );
    const neo: GraphProvider = new Neo4jGraphProvider({
      url: "bolt://localhost:7687",
      username: "neo4j",
      password: "test",
    });
    await neo.open();
    try {
      runs.push({ name: "neo4j", result: await runTypedGraphSuite(neo) });
    } finally {
      await neo.close();
      vi.doUnmock("neo4j-driver");
      vi.resetModules();
    }
  }, 120_000);

  afterAll(() => {
    if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
  });

  it("both backends ran", () => {
    expect(runs.map((r) => r.name).sort()).toEqual(["neo4j", "sqlite"]);
  });

  it("each backend matches portable EXPECTED_TYPED", () => {
    for (const run of runs) {
      expect(run.result.relatedIdsDepth1, `${run.name} depth1`).toEqual(
        EXPECTED_TYPED.relatedIdsDepth1,
      );
      expect(run.result.relatedIdsDepth2, `${run.name} depth2`).toEqual(
        EXPECTED_TYPED.relatedIdsDepth2,
      );
      expect(run.result.relatedIdsOut, `${run.name} out`).toEqual(
        EXPECTED_TYPED.relatedIdsOut,
      );
      expect(run.result.relatedIdsIn, `${run.name} in`).toEqual(
        EXPECTED_TYPED.relatedIdsIn,
      );
      expect(run.result.relatedByRelation, `${run.name} relation`).toEqual(
        EXPECTED_TYPED.relatedByRelation,
      );
      expect(run.result.afterUnlink, `${run.name} unlink`).toEqual(
        EXPECTED_TYPED.afterUnlink,
      );
      expect(run.result.afterDelete, `${run.name} delete`).toEqual(
        EXPECTED_TYPED.afterDelete,
      );
    }
  });

  it("SQLite and Neo4j typed results are identical", () => {
    const sqliteRun = runs.find((r) => r.name === "sqlite");
    const neoRun = runs.find((r) => r.name === "neo4j");
    expect(sqliteRun).toBeTruthy();
    expect(neoRun).toBeTruthy();
    const normalize = (r: NonNullable<typeof sqliteRun>["result"]) => ({
      relatedIdsDepth1: r.relatedIdsDepth1,
      relatedIdsDepth2: r.relatedIdsDepth2,
      relatedIdsOut: r.relatedIdsOut,
      relatedIdsIn: r.relatedIdsIn,
      relatedByRelation: r.relatedByRelation,
      afterUnlink: r.afterUnlink,
      afterDelete: r.afterDelete,
      entityId: r.entityId,
    });
    expect(normalize(sqliteRun!.result)).toEqual(normalize(neoRun!.result));
  });
});
