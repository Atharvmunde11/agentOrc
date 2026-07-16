/**
 * Shared test helpers — mock OpenAI-compatible embedding + chat endpoints.
 */

import { afterEach, beforeEach, vi } from "vitest";
import { Wolbarg } from "../src/index.js";
import type { InitOptions } from "../src/index.js";

export const EMBED_DIMS = 8;

/** Deterministic pseudo-embedding from text (stable across runs). */
export function fakeEmbedding(text: string, dims = EMBED_DIMS): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const idx = i % dims;
    vector[idx] = (vector[idx] ?? 0) + (text.charCodeAt(i) % 31) / 31;
  }
  // L2 normalize
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** Build init options with optional deep overrides for nested configs. */
export function baseInitOptions(
  overrides: Partial<InitOptions> = {},
): InitOptions {
  return {
    organization: overrides.organization ?? "test-org",
    database: {
      provider: "sqlite" as const,
      connectionString:
        overrides.database?.connectionString ?? ":memory:",
    },
    embedding: {
      baseUrl: "https://embed.test/v1",
      apiKey: "test-embed-key",
      model: "test-embed-model",
      ...overrides.embedding,
    },
    llm: {
      baseUrl: "https://llm.test/v1",
      apiKey: "test-llm-key",
      model: "test-llm-model",
      temperature: 0.1,
      maxTokens: 256,
      ...overrides.llm,
    },
  };
}

export function installFetchMock(options?: {
  summaryText?: string;
  failEmbeddings?: boolean;
  failLlm?: boolean;
}): void {
  const summaryText =
    options?.summaryText ?? "Compressed summary of related memories.";

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
        if (options?.failEmbeddings) {
          return new Response(
            JSON.stringify({ error: { message: "embedding down" } }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = init?.body ? JSON.parse(String(init.body)) as { input?: string } : {};
        const text = typeof body.input === "string" ? body.input : "";
        return new Response(
          JSON.stringify({
            data: [{ embedding: fakeEmbedding(text) }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/chat/completions")) {
        if (options?.failLlm) {
          return new Response(
            JSON.stringify({ error: { message: "llm down" } }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: summaryText } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

export async function createInitializedClient(
  overrides?: Partial<InitOptions>,
  fetchOptions?: Parameters<typeof installFetchMock>[0],
): Promise<Wolbarg> {
  installFetchMock(fetchOptions);
  const ctx = new Wolbarg();
  await ctx.init(baseInitOptions(overrides));
  return ctx;
}

export function useClientLifecycle(): {
  getClient: () => Wolbarg;
} {
  let client: Wolbarg;

  beforeEach(async () => {
    client = await createInitializedClient();
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  return {
    getClient: () => client,
  };
}
