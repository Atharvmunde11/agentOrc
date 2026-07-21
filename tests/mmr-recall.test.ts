import { afterEach, describe, expect, it, vi } from "vitest";
import { Wolbarg } from "../src/index.js";
import { baseInitOptions, installFetchMock } from "./helpers.js";

describe("recall MMR", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("diversifies candidates instead of no-op budgeting", async () => {
    installFetchMock();

    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions({ organization: "mmr-org" }));

    const dupText = "alpha beta gamma";
    const uniqueText = "zeta eta theta";

    const m1 = await ctx.remember({
      agent: "a",
      content: { text: dupText },
    });
    const m2 = await ctx.remember({
      agent: "a",
      content: { text: dupText },
    });
    const m3 = await ctx.remember({
      agent: "a",
      content: { text: uniqueText },
    });

    // Without MMR, topK=2 should be the duplicate pair.
    const semantic = await ctx.recall({
      query: dupText,
      topK: 2,
    });
    const semanticIds = semantic.map((r) => r.id);
    expect(semanticIds).toContain(m1.id);
    expect(semanticIds).toContain(m2.id);
    expect(semanticIds).not.toContain(m3.id);

    // With MMR (low lambda -> prioritize diversity), ensure the unique
    // memory enters the result set.
    const diversified = await ctx.recall({
      query: dupText,
      topK: 2,
      mmr: { lambda: 0.2 },
    });
    const mmrIds = diversified.map((r) => r.id);
    expect(mmrIds).toContain(m3.id);

    // At most one of the duplicates should remain after diversification.
    const dupCount = mmrIds.filter(
      (id) => id === m1.id || id === m2.id,
    ).length;
    expect(dupCount).toBe(1);

    await ctx.close();
  });

  it("still returns exactly topK results", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions({ organization: "mmr-org2" }));

    await ctx.remember({ agent: "a", content: { text: "a b c" } });
    await ctx.remember({ agent: "a", content: { text: "d e f" } });
    await ctx.remember({ agent: "a", content: { text: "g h i" } });

    const out = await ctx.recall({ query: "a b c", topK: 2, mmr: true });
    expect(out).toHaveLength(2);

    await ctx.close();
  });
});

