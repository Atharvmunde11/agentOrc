import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Wolbarg,
  ConfigurationError,
  InitializationError,
} from "../src/index.js";
import { baseInitOptions, installFetchMock } from "./helpers.js";

describe("initialization", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("initializes successfully with valid config", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions());
    expect(ctx.isInitialized).toBe(true);
    const stats = await ctx.stats();
    expect(stats.organization).toBe("test-org");
    expect(stats.embeddingModel).toBe("test-embed-model");
    expect(stats.llmModel).toBe("test-llm-model");
    expect(stats.embeddingDimensions).toBe(8);
    expect(stats.totalMemories).toBe(0);
    await ctx.close();
  });

  it("rejects double initialization", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await ctx.init(baseInitOptions());
    await expect(ctx.init(baseInitOptions())).rejects.toBeInstanceOf(
      InitializationError,
    );
    await ctx.close();
  });

  it("rejects missing organization", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await expect(
      ctx.init(baseInitOptions({ organization: "   " })),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rejects invalid embedding baseUrl", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await expect(
      ctx.init(
        baseInitOptions({
          embedding: {
            baseUrl: "not-a-url",
            apiKey: "k",
            model: "m",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rejects unsupported database provider", async () => {
    installFetchMock();
    const ctx = new Wolbarg();
    await expect(
      ctx.init({
        ...baseInitOptions(),
        database: {
          provider: "qdrant" as "sqlite",
          connectionString: "./x.db",
        },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("fails when embedding endpoint is unreachable", async () => {
    installFetchMock({ failEmbeddings: true });
    const ctx = new Wolbarg();
    await expect(ctx.init(baseInitOptions())).rejects.toThrow();
    expect(ctx.isInitialized).toBe(false);
  });

  it("requires init before API use", async () => {
    const ctx = new Wolbarg();
    await expect(
      ctx.remember({
        agent: "a",
        content: { text: "hello" },
      }),
    ).rejects.toBeInstanceOf(InitializationError);
  });
});
