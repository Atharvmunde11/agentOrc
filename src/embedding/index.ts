/**
 * Embedding providers and named factories.
 *
 * ## Custom embedding providers
 *
 * Pass any object that implements {@link EmbeddingProvider} as `embedding` in
 * {@link WolbargOptions}:
 *
 * ```ts
 * const myEmbedder: EmbeddingProvider = {
 *   model: "my-embed-model",
 *   async embed(text) {
 *     // Return a Float32Array of fixed dimensionality
 *     return new Float32Array([...]);
 *   },
 *   // Optional — if omitted, the SDK parallelizes `embed` via embedMany
 *   async embedBatch(texts) {
 *     return Promise.all(texts.map((t) => this.embed(t)));
 *   },
 *   async validate() {
 *     const v = await this.embed("health check");
 *     return { dimensions: v.length };
 *   },
 * };
 *
 * const ctx = wolbarg({
 *   organization: "acme",
 *   database: { provider: "sqlite", url: "./memory.db" },
 *   embedding: myEmbedder, // or openaiEmbedding({ ... })
 * });
 * ```
 *
 * Built-in factories wrap OpenAI-compatible `POST {baseUrl}/embeddings` APIs.
 * **Important:** keep the same model (and dimensions) for the lifetime of a
 * database — mixing models will cause dimension mismatch errors.
 */

import type { EmbeddingConfig } from "../types/index.js";
import { EmbeddingError } from "../errors/index.js";
import { joinUrl } from "../utils/index.js";

/**
 * Contract for any embedding backend used by Wolbarg.
 *
 * Implement this to plug in Voyage, Cohere, a local ONNX model, etc. Vectors
 * must be finite floats; dimensionality is fixed after the first successful
 * {@link EmbeddingProvider.validate} / remember.
 */
export interface EmbeddingProvider {
  /** Embedding model id (telemetry + cache key namespace). */
  readonly model: string;
  /**
   * Produce a float embedding for the given text.
   *
   * @param text - Non-empty content to embed (memory text or recall query).
   * @returns Dense vector as `Float32Array` (same length for every call).
   */
  embed(text: string): Promise<Float32Array>;
  /**
   * Optional batch embedding. When present, {@link embedMany} and ingest prefer it.
   * When absent, the SDK falls back to concurrent single {@link embed} calls.
   *
   * @param texts - Texts to embed in one request when the API supports batching.
   * @returns One vector per input text, same order as `texts`.
   */
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
  /**
   * Connectivity + dimension probe used during {@link Wolbarg.ready}.
   *
   * @returns Object with `dimensions` equal to the vector length.
   * @throws When the endpoint is unreachable or returns an empty vector.
   */
  validate(): Promise<{ dimensions: number }>;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

/**
 * OpenAI-compatible embeddings client (`POST {baseUrl}/embeddings`).
 *
 * @param config - See {@link EmbeddingConfig} (`baseUrl`, `apiKey`, `model`,
 *   optional `timeoutMs`).
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  /** Model name sent in the request body. */
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  /**
   * @param config - OpenAI-compatible embedding endpoint settings.
   * @param config.baseUrl - API root, e.g. `https://api.openai.com/v1`.
   * @param config.apiKey - Bearer token. Use any non-empty string for local
   *   servers that ignore auth.
   * @param config.model - Embedding model id (e.g. `"text-embedding-3-small"`).
   * @param config.timeoutMs - Abort after this many ms. Defaults to `30_000`.
   */
  constructor(config: EmbeddingConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /**
   * Embed a single string.
   *
   * @param text - Input text.
   * @returns Embedding vector.
   * @throws {EmbeddingError} On HTTP errors, timeouts, or empty vectors.
   */
  async embed(text: string): Promise<Float32Array> {
    const response = await this.request(text);
    const vector = response.data?.[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new EmbeddingError("Embedding response did not contain a vector");
    }
    return Float32Array.from(vector);
  }

  /**
   * Embed multiple strings in one API call when the server supports batch input.
   * Falls back to sequential {@link embed} if the response length mismatches.
   *
   * @param texts - Inputs to embed.
   * @returns One vector per input, same order.
   */
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

  /**
   * Probe the endpoint and report vector dimensionality.
   *
   * @returns `{ dimensions }` from a fixed health-check string.
   * @throws {EmbeddingError} When the probe fails.
   */
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

  /**
   * Low-level HTTP request to `/embeddings`.
   *
   * @param input - Single string or batch of strings.
   * @returns Parsed OpenAI-style JSON body.
   */
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

  /** @param error - Unknown thrown value. @returns Human-readable message. */
  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/**
 * Build an {@link EmbeddingProvider} from {@link EmbeddingConfig}.
 *
 * @param config - Full config including `baseUrl`, `apiKey`, and `model`.
 * @returns A ready-to-use {@link OpenAICompatibleEmbeddingProvider}.
 *
 * @example
 * ```ts
 * const embedding = createEmbeddingProvider({
 *   baseUrl: "https://api.openai.com/v1",
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "text-embedding-3-small",
 * });
 * ```
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): EmbeddingProvider {
  return new OpenAICompatibleEmbeddingProvider(config);
}

/**
 * Internal helper that binds a default `baseUrl` for named factory exports.
 *
 * @param defaults - Must include `baseUrl`.
 * @returns A factory where `baseUrl` may be omitted by the caller.
 */
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

/**
 * OpenAI-compatible embeddings with an explicit `baseUrl`.
 *
 * @param config - Full {@link EmbeddingConfig} including `baseUrl`.
 * @returns {@link EmbeddingProvider} instance.
 *
 * @example
 * ```ts
 * embedding: openaiCompatibleEmbedding({
 *   baseUrl: "https://my-proxy.example.com/v1",
 *   apiKey: process.env.API_KEY!,
 *   model: "text-embedding-3-small",
 * })
 * ```
 */
export const openaiCompatibleEmbedding = (
  config: EmbeddingConfig,
): EmbeddingProvider => createEmbeddingProvider(config);

/**
 * OpenAI Embeddings API (`https://api.openai.com/v1`).
 *
 * @param config - `apiKey` and `model` required (e.g. `"text-embedding-3-small"`);
 *   optional `timeoutMs` and override `baseUrl`.
 * @returns {@link EmbeddingProvider} for use as `embedding` in {@link WolbargOptions}.
 *
 * @example
 * ```ts
 * embedding: openaiEmbedding({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "text-embedding-3-small",
 * })
 * ```
 */
export const openaiEmbedding = factory({
  baseUrl: "https://api.openai.com/v1",
});

/**
 * Local Ollama embeddings (`http://127.0.0.1:11434/v1`).
 *
 * @param config - `apiKey` may be any non-empty string; `model` is the Ollama
 *   embedding model (e.g. `"nomic-embed-text"`).
 * @returns {@link EmbeddingProvider} for local Ollama.
 */
export const ollamaEmbedding = factory({
  baseUrl: "http://127.0.0.1:11434/v1",
});

/**
 * OpenRouter embeddings (`https://openrouter.ai/api/v1`).
 *
 * @param config - OpenRouter API key and routed embedding model id.
 * @returns {@link EmbeddingProvider} for OpenRouter.
 */
export const openRouterEmbedding = factory({
  baseUrl: "https://openrouter.ai/api/v1",
});

/**
 * LM Studio local server embeddings (`http://127.0.0.1:1234/v1`).
 *
 * @param config - Local API key (often unused) and the loaded embedding model name.
 * @returns {@link EmbeddingProvider} for LM Studio.
 */
export const lmStudioEmbedding = factory({
  baseUrl: "http://127.0.0.1:1234/v1",
});

/**
 * Google Gemini embeddings via the OpenAI-compatible endpoint.
 * Default base: `https://generativelanguage.googleapis.com/v1beta/openai`.
 *
 * @param config - Gemini API key and embedding model (e.g. `"text-embedding-004"`).
 * @returns {@link EmbeddingProvider} for Gemini.
 */
export const geminiEmbedding = factory({
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
});

/**
 * Together AI embeddings (`https://api.together.xyz/v1`).
 *
 * @param config - Together API key and embedding model id.
 * @returns {@link EmbeddingProvider} for Together.
 */
export const togetherEmbedding = factory({
  baseUrl: "https://api.together.xyz/v1",
});

/**
 * vLLM OpenAI-compatible embeddings (`http://127.0.0.1:8000/v1`).
 *
 * @param config - Local/server API key (if required) and the served model name.
 * @returns {@link EmbeddingProvider} for vLLM.
 */
export const vllmEmbedding = factory({
  baseUrl: "http://127.0.0.1:8000/v1",
});

/**
 * Embed many texts, preferring {@link EmbeddingProvider.embedBatch} when available.
 * Otherwise runs up to `concurrency` parallel {@link EmbeddingProvider.embed} calls.
 *
 * @param provider - Embedding backend.
 * @param texts - Strings to embed (order preserved in the result).
 * @param concurrency - Max parallel single embeds when `embedBatch` is absent.
 *   Defaults to `8`.
 * @returns One `Float32Array` per input text.
 */
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
