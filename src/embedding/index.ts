/**
 * Embedding providers and named factories.
 */

import type { EmbeddingConfig } from "../types/index.js";
import { EmbeddingError } from "../errors/index.js";
import { joinUrl } from "../utils/index.js";

/** Contract for any embedding backend. */
export interface EmbeddingProvider {
  readonly model: string;
  /** Produce a float embedding for the given text. */
  embed(text: string): Promise<Float32Array>;
  /** Optional batch embedding. SDK falls back to parallel `embed` when absent. */
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
  /** Lightweight connectivity + dimension probe. */
  validate(): Promise<{ dimensions: number }>;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: EmbeddingConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await this.request(text);
    const vector = response.data?.[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new EmbeddingError("Embedding response did not contain a vector");
    }
    return Float32Array.from(vector);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.length === 1) {
      return [await this.embed(texts[0]!)];
    }
    const response = await this.request(texts);
    const data = response.data ?? [];
    const sorted = [...data].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    if (sorted.length !== texts.length) {
      // Fallback: embed sequentially
      const out: Float32Array[] = [];
      for (const text of texts) {
        out.push(await this.embed(text));
      }
      return out;
    }
    return sorted.map((item) => {
      if (!item.embedding || item.embedding.length === 0) {
        throw new EmbeddingError("Embedding batch response contained an empty vector");
      }
      return Float32Array.from(item.embedding);
    });
  }

  async validate(): Promise<{ dimensions: number }> {
    try {
      const embedding = await this.embed("Wolbarg health check");
      return { dimensions: embedding.length };
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error;
      }
      throw new EmbeddingError(
        `Failed to validate embedding endpoint: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private async request(
    input: string | string[],
  ): Promise<OpenAIEmbeddingResponse> {
    const url = joinUrl(this.baseUrl, "/embeddings");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
        signal: controller.signal,
      });

      let body: OpenAIEmbeddingResponse;
      try {
        body = (await res.json()) as OpenAIEmbeddingResponse;
      } catch {
        throw new EmbeddingError(
          `Embedding endpoint returned non-JSON response (HTTP ${res.status})`,
        );
      }

      if (!res.ok) {
        const message = body.error?.message ?? `HTTP ${res.status}`;
        throw new EmbeddingError(`Embedding request failed: ${message}`);
      }

      return body;
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new EmbeddingError(
          `Embedding request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new EmbeddingError(
        `Embedding request failed: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
): EmbeddingProvider {
  return new OpenAICompatibleEmbeddingProvider(config);
}

function factory(
  defaults: Partial<EmbeddingConfig> & Pick<EmbeddingConfig, "baseUrl">,
) {
  return (config: Omit<EmbeddingConfig, "baseUrl"> & { baseUrl?: string }): EmbeddingProvider =>
    createEmbeddingProvider({
      baseUrl: config.baseUrl ?? defaults.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
}

export const openaiCompatibleEmbedding = (
  config: EmbeddingConfig,
): EmbeddingProvider => createEmbeddingProvider(config);

export const openaiEmbedding = factory({
  baseUrl: "https://api.openai.com/v1",
});

export const ollamaEmbedding = factory({
  baseUrl: "http://127.0.0.1:11434/v1",
});

export const openRouterEmbedding = factory({
  baseUrl: "https://openrouter.ai/api/v1",
});

export const lmStudioEmbedding = factory({
  baseUrl: "http://127.0.0.1:1234/v1",
});

export const geminiEmbedding = factory({
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
});

export const togetherEmbedding = factory({
  baseUrl: "https://api.together.xyz/v1",
});

export const vllmEmbedding = factory({
  baseUrl: "http://127.0.0.1:8000/v1",
});

/** Embed many texts, using batch API when available. */
export async function embedMany(
  provider: EmbeddingProvider,
  texts: string[],
  concurrency = 8,
): Promise<Float32Array[]> {
  if (provider.embedBatch) {
    return provider.embedBatch(texts);
  }
  const out: Float32Array[] = new Array(texts.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < texts.length) {
      const current = index;
      index += 1;
      out[current] = await provider.embed(texts[current]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, texts.length) }, () => worker()),
  );
  return out;
}
