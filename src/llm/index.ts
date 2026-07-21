/**
 * LLM provider abstractions and OpenAI-compatible chat implementation.
 *
 * Used for memory compression ({@link Wolbarg.compress}) and experimental
 * {@link Wolbarg.rememberFromMessages} extract mode.
 *
 * ## Custom LLM providers
 *
 * Pass any object that implements {@link LlmProvider} as `llm` in
 * {@link WolbargOptions}:
 *
 * ```ts
 * const myLlm: LlmProvider = {
 *   model: "my-model",
 *   async complete(messages) {
 *     // Call your backend; return the assistant text
 *     return "...";
 *   },
 *   async validate() {
 *     await this.complete([{ role: "user", content: "ok" }]);
 *   },
 * };
 *
 * const ctx = wolbarg({
 *   organization: "acme",
 *   database: { provider: "sqlite", url: "./memory.db" },
 *   embedding: openaiEmbedding({ apiKey: "...", model: "text-embedding-3-small" }),
 *   llm: myLlm, // or openaiLlm({ ... }) / openaiCompatibleLlm({ ... })
 * });
 * ```
 *
 * Built-in factories (`openaiLlm`, `ollamaLlm`, `openRouterLlm`,
 * `openaiCompatibleLlm`) wrap any OpenAI-compatible `/v1/chat/completions` API.
 */

import type { LlmConfig } from "../types/index.js";
import { CompressionError } from "../errors/index.js";
import { joinUrl } from "../utils/index.js";

/**
 * One message in a chat completion request.
 *
 * @property role - Speaker role. Use `"system"` for instructions, `"user"` for
 *   prompts, `"assistant"` for prior model turns.
 * @property content - Plain-text message body (non-empty for useful completions).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Contract for any chat completion backend used by Wolbarg.
 *
 * Implement this interface to plug in a custom LLM (Anthropic, local GGUF via
 * a custom HTTP bridge, Azure OpenAI with extra headers, etc.). The SDK only
 * requires {@link LlmProvider.complete} to return the assistant reply as a
 * string; streaming is not used.
 *
 * @example Custom provider
 * ```ts
 * const anthropicLike: LlmProvider = {
 *   model: "claude-sonnet",
 *   async complete(messages) {
 *     const res = await fetch("https://api.example.com/complete", {
 *       method: "POST",
 *       body: JSON.stringify({ messages }),
 *     });
 *     const data = await res.json();
 *     return String(data.text);
 *   },
 *   async validate() {
 *     const reply = await this.complete([{ role: "user", content: "ping" }]);
 *     if (!reply.trim()) throw new Error("empty reply");
 *   },
 * };
 * ```
 */
export interface LlmProvider {
  /** Model identifier reported in telemetry / logs (any non-empty string). */
  readonly model: string;
  /**
   * Run a chat completion and return the assistant message text.
   *
   * @param messages - Ordered conversation turns. The last message is typically
   *   the user (or system+user) prompt the SDK builds for compression / extract.
   * @returns Trimmed assistant text. Empty responses should throw.
   * @throws When the backend fails, times out, or returns no text.
   */
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Lightweight connectivity probe invoked during boot when an LLM is configured.
   * Implementations typically call {@link LlmProvider.complete} with a tiny prompt.
   *
   * @throws When the endpoint is unreachable or misconfigured.
   */
  validate(): Promise<void>;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * OpenAI-compatible chat completions client (`POST {baseUrl}/chat/completions`).
 *
 * Works with OpenAI, Ollama, OpenRouter, LM Studio, vLLM, Azure OpenAI (when
 * the path matches), and any other server that speaks the same JSON schema.
 *
 * @param config - See {@link LlmConfig} for each field (`baseUrl`, `apiKey`,
 *   `model`, optional `temperature`, `maxTokens`, `timeoutMs`).
 */
export class OpenAICompatibleLlmProvider implements LlmProvider {
  /** Model name sent in the request body and exposed on the provider. */
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  /**
   * @param config - OpenAI-compatible endpoint settings.
   * @param config.baseUrl - API root, e.g. `https://api.openai.com/v1` (no trailing `/chat/completions`).
   * @param config.apiKey - Bearer token (`Authorization: Bearer …`). Use any non-empty
   *   string for local servers that ignore auth (e.g. `"ollama"`).
   * @param config.model - Chat model id (e.g. `"gpt-4o-mini"`, `"llama3.2"`).
   * @param config.temperature - Sampling temperature. Defaults to `0.2`.
   * @param config.maxTokens - Max completion tokens. Defaults to `4096`.
   * @param config.timeoutMs - Abort after this many ms. Defaults to `60_000`.
   */
  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.temperature = config.temperature ?? 0.2;
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * Call `/chat/completions` and return the first choice’s message content.
   *
   * @param messages - Chat turns in OpenAI message format.
   * @returns Trimmed assistant text.
   * @throws {CompressionError} On HTTP errors, timeouts, or empty content.
   */
  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await this.request(messages);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new CompressionError("LLM response did not contain text content");
    }
    return content.trim();
  }

  /**
   * Probe the endpoint with a fixed `"ok"` prompt.
   *
   * @throws {CompressionError} When validation fails.
   */
  async validate(): Promise<void> {
    try {
      await this.complete([
        {
          role: "user",
          content: 'Reply with exactly the word "ok".',
        },
      ]);
    } catch (error) {
      if (error instanceof CompressionError) {
        throw new CompressionError(
          `Failed to validate LLM endpoint: ${error.message}`,
          { cause: error },
        );
      }
      throw new CompressionError(
        `Failed to validate LLM endpoint: ${this.describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  /**
   * Low-level HTTP request to `/chat/completions`.
   *
   * @param messages - Chat turns to send.
   * @returns Parsed OpenAI-style JSON body.
   */
  private async request(messages: ChatMessage[]): Promise<OpenAIChatResponse> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
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
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        }),
        signal: controller.signal,
      });

      let body: OpenAIChatResponse;
      try {
        body = (await res.json()) as OpenAIChatResponse;
      } catch {
        throw new CompressionError(
          `LLM endpoint returned non-JSON response (HTTP ${res.status})`,
        );
      }

      if (!res.ok) {
        const message = body.error?.message ?? `HTTP ${res.status}`;
        throw new CompressionError(`LLM request failed: ${message}`);
      }

      return body;
    } catch (error) {
      if (error instanceof CompressionError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new CompressionError(
          `LLM request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new CompressionError(`LLM request failed: ${this.describe(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
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
 * Build an {@link LlmProvider} from {@link LlmConfig}.
 *
 * Prefer named helpers ({@link openaiLlm}, {@link ollamaLlm}, …) when the
 * default `baseUrl` matches your host; use this (or {@link openaiCompatibleLlm})
 * when you need a fully custom base URL.
 *
 * @param config - Full OpenAI-compatible config including `baseUrl`.
 * @returns A ready-to-use {@link OpenAICompatibleLlmProvider}.
 *
 * @example
 * ```ts
 * const llm = createLlmProvider({
 *   baseUrl: "https://api.openai.com/v1",
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "gpt-4o-mini",
 *   temperature: 0.2,
 *   maxTokens: 4096,
 * });
 * ```
 */
export function createLlmProvider(config: LlmConfig): LlmProvider {
  return new OpenAICompatibleLlmProvider(config);
}

/**
 * Internal helper that binds a default `baseUrl` for named factory exports.
 *
 * @param defaults - Must include `baseUrl`; other {@link LlmConfig} fields optional.
 * @returns A factory `(config) => LlmProvider` where `baseUrl` may be omitted.
 */
function llmFactory(
  defaults: Partial<LlmConfig> & Pick<LlmConfig, "baseUrl">,
) {
  return (config: Omit<LlmConfig, "baseUrl"> & { baseUrl?: string }): LlmProvider =>
    createLlmProvider({
      baseUrl: config.baseUrl ?? defaults.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
    });
}

/**
 * OpenAI-compatible LLM with an explicit `baseUrl` (any compatible host).
 *
 * @param config - Full {@link LlmConfig} including `baseUrl`, `apiKey`, `model`.
 * @returns {@link LlmProvider} instance.
 *
 * @example
 * ```ts
 * llm: openaiCompatibleLlm({
 *   baseUrl: "https://my-proxy.example.com/v1",
 *   apiKey: process.env.API_KEY!,
 *   model: "gpt-4o-mini",
 * })
 * ```
 */
export const openaiCompatibleLlm = (config: LlmConfig): LlmProvider =>
  createLlmProvider(config);

/**
 * OpenAI Chat Completions (`https://api.openai.com/v1`).
 *
 * @param config - `apiKey` and `model` required; optional `temperature`,
 *   `maxTokens`, `timeoutMs`, and override `baseUrl`.
 * @returns {@link LlmProvider} for use as `llm` in {@link WolbargOptions}.
 *
 * @example
 * ```ts
 * llm: openaiLlm({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: "gpt-4o-mini",
 * })
 * ```
 */
export const openaiLlm = llmFactory({
  baseUrl: "https://api.openai.com/v1",
});

/**
 * Local Ollama OpenAI-compatible API (`http://127.0.0.1:11434/v1`).
 *
 * @param config - `apiKey` may be any non-empty string (Ollama often ignores it);
 *   `model` is the Ollama model name (e.g. `"llama3.2"`).
 * @returns {@link LlmProvider} pointing at the local Ollama server.
 *
 * @example
 * ```ts
 * llm: ollamaLlm({ apiKey: "ollama", model: "llama3.2" })
 * ```
 */
export const ollamaLlm = llmFactory({
  baseUrl: "http://127.0.0.1:11434/v1",
});

/**
 * OpenRouter chat API (`https://openrouter.ai/api/v1`).
 *
 * @param config - Use your OpenRouter API key and a routed model id
 *   (e.g. `"openai/gpt-4o-mini"`).
 * @returns {@link LlmProvider} for OpenRouter.
 *
 * @example
 * ```ts
 * llm: openRouterLlm({
 *   apiKey: process.env.OPENROUTER_API_KEY!,
 *   model: "openai/gpt-4o-mini",
 * })
 * ```
 */
export const openRouterLlm = llmFactory({
  baseUrl: "https://openrouter.ai/api/v1",
});
