import { afterEach, describe, expect, it, vi } from "vitest";
import { Wolbarg } from "../src/index.js";
import { resolveMemoryDedupeConfig } from "../src/memory/dedupe.js";
import { baseInitOptions, installFetchMock } from "./helpers.js";

describe("memory dedupe defaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults nearThreshold to 0.92 for near strategy", () => {
    const resolved = resolveMemoryDedupeConfig({ strategy: "near" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.strategy).toBe("near");
    expect(resolved.nearThreshold).toBe(0.92);
    expect(resolved.nearCandidateLimit).toBe(8);
  });

  it("applies the near-dedupe default threshold during remember()", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions({ organization: "dedupe-default-org" }));

    // Similar-but-not-identical strings (cosine similarity > 0.92 with the
    // test embedder), so near-dedupe should merge via default threshold.
    const t1 = "alpha beta";
    const t2 = "alpha betas";

    const r1 = await ctx.remember({
      agent: "a",
      content: { text: t1 },
      dedupe: { strategy: "near" },
    });

    const r2 = await ctx.remember({
      agent: "a",
      content: { text: t2 },
      dedupe: { strategy: "near" },
    });

    expect(r1.action).toBe("created");
    expect(r2.action).toBe("updated");
    expect(r2.id).toBe(r1.id);

    await ctx.close();
  });
});

