/**
 * Shared typed-method cases for graph parity + per-backend tests.
 */

import { expect } from "vitest";
import type { GraphProvider } from "../src/graph/types.js";

export async function runTypedGraphSuite(graph: GraphProvider): Promise<{
  relatedIdsDepth1: string[];
  relatedIdsDepth2: string[];
  relatedIdsOut: string[];
  relatedIdsIn: string[];
  relatedByRelation: string[];
  entityId: string;
  afterUnlink: string[];
  afterDelete: string[];
}> {
  await graph.linkMemories("m1", "m2", "references", { note: "a→b" });
  await graph.linkMemories("m2", "m3", "references", { note: "b→c" });
  await graph.linkMemories("m1", "m3", "mentions");

  const depth1 = await graph.getRelated("m1", { depth: 1, direction: "both" });
  const relatedIdsDepth1 = depth1.map((r) => r.id).sort();

  const depth2 = await graph.getRelated("m1", { depth: 2, direction: "out" });
  const relatedIdsDepth2 = depth2.map((r) => r.id).sort();

  const out = await graph.getRelated("m1", { depth: 1, direction: "out" });
  const relatedIdsOut = out.map((r) => r.id).sort();

  const inn = await graph.getRelated("m2", { depth: 1, direction: "in" });
  const relatedIdsIn = inn.map((r) => r.id).sort();

  const byRel = await graph.getRelated("m1", {
    depth: 1,
    direction: "out",
    relation: "mentions",
  });
  const relatedByRelation = byRel.map((r) => r.id).sort();

  const entityId = await graph.upsertEntity({
    name: "Alice",
    type: "Person",
    metadata: { role: "lead" },
  });
  // Idempotent upsert — same id.
  const entityId2 = await graph.upsertEntity({
    name: "Alice",
    type: "Person",
    metadata: { role: "lead" },
  });
  expect(entityId2).toBe(entityId);

  await graph.linkEntityToMemory(entityId, "m1", "subject");

  await graph.unlinkMemories("m1", "m3", "mentions");
  const afterUnlink = (
    await graph.getRelated("m1", {
      depth: 1,
      direction: "out",
      relation: "mentions",
    })
  )
    .map((r) => r.id)
    .sort();

  await graph.deleteMemory("m3");
  const afterDelete = (await graph.getRelated("m1", { depth: 2, direction: "out" }))
    .map((r) => r.id)
    .sort();

  const health = await graph.health();
  expect(health.ok).toBe(true);
  expect(health.backend).toBe(graph.name);

  return {
    relatedIdsDepth1,
    relatedIdsDepth2,
    relatedIdsOut,
    relatedIdsIn,
    relatedByRelation,
    entityId,
    afterUnlink,
    afterDelete,
  };
}

/** Expected portable outcomes for {@link runTypedGraphSuite}. */
export const EXPECTED_TYPED = {
  relatedIdsDepth1: ["m2", "m3"],
  relatedIdsDepth2: ["m2", "m3"],
  relatedIdsOut: ["m2", "m3"],
  relatedIdsIn: ["m1"],
  relatedByRelation: ["m3"],
  afterUnlink: [] as string[],
  afterDelete: ["m2"],
};
