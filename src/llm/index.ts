/**
 * LLM provider abstractions and OpenAI-compatible chat implementation.
 * Used for memory compression and experimental rememberFromMessages extract mode.
 */

import type { LlmConfig } from "../types/index.js";
import { CompressionError } from "../errors/index.js";
import { joinUrl } from "../utils/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Contract for any chat completion backend. */
export interface LlmProvider {
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<string>;
  /** Lightweight connectivity probe. */
  validate(): Promise<void>;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

export class OpenAICompatibleLlmProvider implements LlmProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.temperature = config.temperature ?? 0.2;
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await this.request(messages);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new CompressionError("LLM response did not contain text content");
    }
    return content.trim();
  }

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

  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

export function createLlmProvider(config: LlmConfig): LlmProvider {
  return new OpenAICompatibleLlmProvider(config);
}

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

export const openaiCompatibleLlm = (config: LlmConfig): LlmProvider =>
  createLlmProvider(config);

export const openaiLlm = llmFactory({
  baseUrl: "https://api.openai.com/v1",
});

export const ollamaLlm = llmFactory({
  baseUrl: "http://127.0.0.1:11434/v1",
});

export const openRouterLlm = llmFactory({
  baseUrl: "https://openrouter.ai/api/v1",
});
