import { afterEach, describe, expect, it, vi } from "vitest";
import { Wolbarg, crossEncoder } from "../src/index.js";
import { fakeEmbedding } from "./helpers.js";

function installFetchMockForRerankEmptyParse(): void {
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
        const bodyRaw = init?.body
          ? JSON.parse(String(init.body))
          : ({ input: undefined } as unknown);
        const body = bodyRaw as { input?: string | string[] };
        const text = Array.isArray(body.input) ? body.input[0] ?? "" : body.input ?? "";
        return new Response(
          JSON.stringify({ data: [{ embedding: fakeEmbedding(text) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/rerank")) {
        // Simulate providers that respond 200 but return an unexpected shape.
        // parseResults(...) will yield an empty list and Wolbarg must fallback.
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("recall reranker fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to identity order when reranker parses 200 as empty", async () => {
    installFetchMockForRerankEmptyParse();

    const reranker = crossEncoder({
      apiKey: "rerank-key",
      baseUrl: "https://rerank.test",
    });

    const ctx = new Wolbarg({
      organization: "rerank-org",
      database: { provider: "sqlite", connectionString: ":memory:" },
      embedding: {
        baseUrl: "https://embed.test/v1",
        apiKey: "embed-key",
        model: "embed-model",
      },
      reranker,
      // No llm/compression needed for recall.
    });

    await ctx.ready();

    const m1 = await ctx.remember({ agent: "a", content: { text: "alpha" } });
    const m2 = await ctx.remember({ agent: "a", content: { text: "beta" } });
    await ctx.remember({ agent: "a", content: { text: "gamma" } });

    const recalled = await ctx.recall({
      query: "alpha",
      topK: 2,
      rerank: true,
    });

    expect(recalled).toHaveLength(2);
    expect(recalled.map((r) => r.id)).toEqual(
      expect.arrayContaining([m1.id, m2.id]),
    );

    await ctx.close();
  });
});

