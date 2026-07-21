import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/index.js";
import { createInitializedClient } from "./helpers.js";

describe("compression", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("compresses memories into a summary and archives originals", async () => {
    const ctx = await createInitializedClient(undefined, {
      summaryText: "Stripe billing: recurring invoices are supported.",
    });

    const a = await ctx.remember({
      agent: "research",
      content: { text: "Stripe supports recurring invoices." },
    });
    const b = await ctx.remember({
      agent: "research",
      content: { text: "Invoices can be billed monthly or yearly." },
    });

    const result = await ctx.compress({ agent: "research" });

    expect(result.summary.content.text).toContain("Stripe billing");
    expect(result.archivedIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(result.summary.metadata).toMatchObject({
      compressed: true,
      sourceCount: 2,
    });

    const active = await ctx.recall({
      query: "Stripe billing",
      topK: 10,
      filter: { agent: "research" },
    });
    expect(active.some((m) => m.id === result.summary.id)).toBe(true);
    expect(active.some((m) => m.id === a.id)).toBe(false);

    // Archived rows are removed from ANN/FTS; verify lineage via history, not recall.
    const history = await ctx.history({ id: a.id });
    expect(history.memory.archived).toBe(true);
    expect(history.memory.compressedInto).toBe(result.summary.id);
    expect(history.events.some((e) => e.eventType === "archived")).toBe(true);

    const summaryHistory = await ctx.history({ id: result.summary.id });
    expect(summaryHistory.events.some((e) => e.eventType === "compressed")).toBe(
      true,
    );

    await ctx.close();
  });

  it("requires at least two active memories", async () => {
    const ctx = await createInitializedClient();
    await ctx.remember({
      agent: "research",
      content: { text: "Only one memory." },
    });
    await expect(ctx.compress({ agent: "research" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await ctx.close();
  });

  it("is atomic: archive failure does not leave summary behind", async () => {
    const ctx = await createInitializedClient(undefined, {
      summaryText: "Atomic compress summary marker.",
    });

    const a = await ctx.remember({
      agent: "research",
      content: { text: "Stripe supports recurring invoices." },
    });
    const b = await ctx.remember({
      agent: "research",
      content: { text: "Invoices can be billed monthly or yearly." },
    });

    const storage = (ctx as any).storage;
    const statements = storage?.statements;
    expect(statements?.archiveMemory?.run).toBeInstanceOf(Function);
    const originalArchiveRun = statements.archiveMemory.run.bind(
      statements.archiveMemory,
    );
    let archiveCalls = 0;

    statements.archiveMemory.run = (...args: unknown[]) => {
      archiveCalls += 1;
      throw new Error(`simulated archive failure (call ${archiveCalls})`);
    };

    try {
      await expect(ctx.compress({ agent: "research" })).rejects.toThrow(
        /simulated archive failure/i,
      );
    } finally {
      statements.archiveMemory.run = originalArchiveRun;
    }

    const stats = await ctx.stats();
    expect(stats.activeMemories).toBe(2);
    expect(stats.archivedMemories).toBe(0);

    const historyA = await ctx.history({ id: a.id });
    expect(historyA.memory.archived).toBe(false);
    expect(historyA.events.some((e) => e.eventType === "archived")).toBe(false);

    const historyB = await ctx.history({ id: b.id });
    expect(historyB.memory.archived).toBe(false);
    expect(historyB.events.some((e) => e.eventType === "archived")).toBe(false);

    await ctx.close();
  });
});
