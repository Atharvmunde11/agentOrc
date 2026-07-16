/**
 * v0.2 feature tests — constructor API, hybrid, filters, chunking, ingest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Wolbarg,
  ProviderNotConfiguredError,
  bm25,
  createChunkingStrategy,
  meta,
  openaiEmbedding,
  openaiLlm,
  sqlite,
} from "../src/index.js";
import { fakeEmbedding, installFetchMock } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("constructor API", () => {
  it("works with storage + embedding factories (no llm)", async () => {
    installFetchMock();
    const ctx = new Wolbarg({
      organization: "ctor-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
    });

    await ctx.ready();
    const mem = await ctx.remember({
      agent: "a",
      content: { text: "hello world" },
    });
    expect(mem.id).toBeTruthy();

    const stats = await ctx.stats();
    expect(stats.llmModel).toBeNull();
    expect(stats.totalMemories).toBe(1);

    await expect(
      // @ts-expect-error compress requires llm at the type level
      ctx.compress({ agent: "a" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await ctx.close();
  });

  it("enables compress when llm is configured", async () => {
    installFetchMock({ summaryText: "summary" });
    const ctx = new Wolbarg({
      organization: "ctor-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
      llm: openaiLlm({
        apiKey: "k",
        model: "m",
        baseUrl: "https://llm.test/v1",
      }),
    });

    await ctx.remember({ agent: "a", content: { text: "fact one about stripe" } });
    await ctx.remember({ agent: "a", content: { text: "fact two about invoices" } });
    const result = await ctx.compress({ agent: "a" });
    expect(result.summary.content.text).toBe("summary");
    expect(result.archivedIds.length).toBe(2);
    await ctx.close();
  });
});

describe("metadata filters", () => {
  it("filters recall by metadata eq", async () => {
    installFetchMock();
    const ctx = new Wolbarg({
      organization: "meta-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
    });

    await ctx.remember({
      agent: "a",
      content: { text: "alpha project notes" },
      metadata: { project: "alpha", priority: 1 },
    });
    await ctx.remember({
      agent: "a",
      content: { text: "beta project notes" },
      metadata: { project: "beta", priority: 2 },
    });

    const hits = await ctx.recall({
      query: "project notes",
      topK: 10,
      filter: { metadata: meta.eq("project", "alpha") },
    });
    expect(hits.every((h) => h.metadata.project === "alpha")).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    await ctx.close();
  });
});

describe("hybrid search", () => {
  it("runs hybrid when keywordSearch is configured", async () => {
    installFetchMock();
    const ctx = new Wolbarg({
      organization: "hybrid-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
      keywordSearch: bm25(),
    });

    await ctx.remember({
      agent: "a",
      content: { text: "The quick brown fox jumps over the lazy dog" },
    });
    await ctx.remember({
      agent: "a",
      content: { text: "Unrelated astronomy facts about nebulae" },
    });

    const hits = await ctx.recall({
      query: "quick brown fox",
      topK: 5,
      hybrid: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content.text.toLowerCase()).toContain("fox");
    await ctx.close();
  });
});

describe("chunking", () => {
  it("splits text with sentence strategy", () => {
    const strategy = createChunkingStrategy("sentence");
    const chunks = strategy.chunk(
      "First sentence here. Second sentence follows. Third one ends.",
      { chunkSize: 40, overlap: 5 },
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });

  it("splits markdown by headings", () => {
    const strategy = createChunkingStrategy("markdown");
    const chunks = strategy.chunk(
      "# Title\n\nIntro paragraph.\n\n## Section\n\nBody text here.",
      { chunkSize: 200, overlap: 0 },
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ingest", () => {
  it("ingests plain text into chunked memories", async () => {
    installFetchMock();
    // Support batch embeddings in mock
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
          if (Array.isArray(body.input)) {
            return new Response(
              JSON.stringify({
                data: body.input.map((text, index) => ({
                  index,
                  embedding: fakeEmbedding(text),
                })),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          const text = typeof body.input === "string" ? body.input : "";
          return new Response(
            JSON.stringify({ data: [{ embedding: fakeEmbedding(text) }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const ctx = new Wolbarg({
      organization: "ingest-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
    });

    const result = await ctx.ingest({
      agent: "docs",
      source: {
        text: "Paragraph one talks about widgets.\n\nParagraph two describes gizmos and gadgets in depth for testing chunking.",
      },
      chunking: { strategy: "paragraph", chunkSize: 200, overlap: 0 },
      metadata: { source: "test" },
    });

    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(result.memories.length).toBe(result.chunkCount);
    expect(result.usedOcr).toBe(false);
    expect(result.memories[0]!.metadata.source).toBe("test");
    await ctx.close();
  });
});

describe("rerank graceful skip", () => {
  it("skips rerank when provider is missing", async () => {
    installFetchMock();
    const ctx = new Wolbarg({
      organization: "rerank-org",
      storage: sqlite(":memory:"),
      embedding: openaiEmbedding({
        apiKey: "k",
        model: "m",
        baseUrl: "https://embed.test/v1",
      }),
    });
    await ctx.remember({ agent: "a", content: { text: "sample memory" } });
    const hits = await ctx.recall({
      query: "sample",
      topK: 3,
      rerank: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    await ctx.close();
  });
});
