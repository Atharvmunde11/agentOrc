/**
 * SqliteGraphProvider — file-backed local graph (no native deps).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphProvider } from "../src/graph/providers/sqlite-graph.js";
import { SqliteCheckpointProvider } from "../src/providers/sqlite/sqliteCheckpointProvider.js";
import { EXPECTED_TYPED, runTypedGraphSuite } from "./graph-parity-cases.js";

describe("SqliteGraphProvider", () => {
  let dir: string;
  let graph: SqliteGraphProvider;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-sqlite-graph-"));
    graph = new SqliteGraphProvider({ path: path.join(dir, "test-graph.db") });
    await graph.open();
  });

  afterEach(async () => {
    await graph.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
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
    expect(result.entityId).toMatch(/^ent_/);
  });

  it("supportsFileSnapshot is true for file-backed graphs", () => {
    expect(graph.supportsFileSnapshot()).toBe(true);
    expect(graph.getDataPath()).toBeTruthy();
  });

  it("query() hard-errors — no Cypher on SQLite", async () => {
    await expect(
      graph.query(`MATCH (m:Memory) RETURN m`),
    ).rejects.toThrow(/raw Cypher queries are not supported/i);
  });

  it("health reports ok after open with node/edge counts", async () => {
    await graph.linkMemories("a", "b", "x");
    const h = await graph.health();
    expect(h.ok).toBe(true);
    expect(h.backend).toBe("sqlite");
    const details = h.details as { nodeCount: number; edgeCount: number };
    expect(details.nodeCount).toBeGreaterThanOrEqual(2);
    expect(details.edgeCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty path in constructor", () => {
    expect(() => new SqliteGraphProvider({ path: "  " })).toThrow(
      /non-empty path/i,
    );
  });

  it("getRelated terminates on cyclical graphs at depth 3+", async () => {
    await graph.linkMemories("A", "B", "next");
    await graph.linkMemories("B", "C", "next");
    await graph.linkMemories("C", "A", "next");

    const related = await graph.getRelated("A", {
      depth: 5,
      direction: "out",
      relation: "next",
    });
    const ids = related.map((r) => r.id).sort();
    expect(ids).toEqual(["B", "C"]);
    // Must not include start; must not hang / explode.
    expect(ids).not.toContain("A");
  });

  it("cascade deleteMemory removes node and incident edges", async () => {
    await graph.linkMemories("m1", "m2", "rel");
    await graph.linkMemories("m2", "m3", "rel");
    await graph.deleteMemory("m2");
    expect(
      (await graph.getRelated("m1", { depth: 2, direction: "out" })).map(
        (r) => r.id,
      ),
    ).toEqual([]);
    expect(
      (await graph.getRelated("m3", { depth: 1, direction: "in" })).map(
        (r) => r.id,
      ),
    ).toEqual([]);
  });

  it("checkpoint / export-style backup + restore round-trips graph file", async () => {
    await graph.linkMemories("x", "y", "keeps");
    const graphPath = graph.getDataPath()!;
    await graph.close();

    const ckDir = path.join(dir, "ck");
    const ck = new SqliteCheckpointProvider({ directory: ckDir });
    await ck.open();
    const snap = await ck.checkpointGraph("g1", graphPath);
    expect(fs.existsSync(snap)).toBe(true);

    // Wipe live graph file then restore.
    fs.rmSync(graphPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${graphPath}${suffix}`;
      if (fs.existsSync(side)) fs.rmSync(side, { force: true });
    }
    await ck.rollbackGraph("g1", graphPath);
    await ck.close();

    graph = new SqliteGraphProvider({ path: graphPath });
    await graph.open();
    const related = await graph.getRelated("x", { depth: 1, direction: "out" });
    expect(related.map((r) => r.id)).toEqual(["y"]);
  });
});
