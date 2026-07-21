/**
 * Memory compression — provider-based summarization of related memories.
 *
 * Compression collapses multiple memories into one summary via an LLM, archiving
 * the originals with lineage. Use {@link createCompressionProvider} or call
 * {@link compressMemories} directly when building custom pipelines.
 *
 * @example
 * ```ts
 * import { createCompressionProvider } from "wolbarg/compression";
 * import { openaiLlm } from "wolbarg/llm";
 *
 * const compression = createCompressionProvider(openaiLlm({ apiKey, model: "gpt-4o-mini" }));
 * const summary = await compression.compress(memories);
 * ```
 */

import type { LlmProvider } from "../llm/index.js";
import type { MemoryRecord } from "../types/index.js";
import { CompressionError } from "../errors/index.js";

const SYSTEM_PROMPT = `You are a memory compression engine for multi-agent systems.
Given related memories from a single agent, produce ONE concise summary that preserves:
- Key facts and decisions
- Important entities, numbers, and identifiers
- Actionable conclusions

Rules:
- Output plain text only (no markdown headings, no bullet lists unless essential)
- Do not invent facts that are not present
- Prefer precision over verbosity
- Keep the summary self-contained`;

/**
 * Contract for memory compression backends.
 *
 * Implement this interface to swap LLM vendors or use rule-based summarizers.
 * Wolbarg's `compress()` facade delegates to the configured provider.
 *
 * @example Custom provider
 * ```ts
 * const rules: CompressionProvider = {
 *   name: "truncate",
 *   async compress(memories) {
 *     return memories.map((m) => m.content.text).join(" | ").slice(0, 500);
 *   },
 * };
 * ```
 */
export interface CompressionProvider {
  /** Provider identifier (e.g. `"llm"`, `"truncate"`). */
  readonly name: string;
  /**
   * Produce a single summary string from related memories.
   * @param memories - Non-empty list of memories to collapse.
   * @returns Plain-text summary.
   * @throws {@link CompressionError} when compression fails or input is empty.
   */
  compress(memories: MemoryRecord[]): Promise<string>;
}

/**
 * Default compression provider wrapping an {@link LlmProvider}.
 *
 * Delegates to {@link compressMemories} with the standard system prompt.
 */
export class LlmCompressionProvider implements CompressionProvider {
  readonly name = "llm";
  private readonly llm: LlmProvider;

  /** @param llm - Configured LLM used for summarization. */
  constructor(llm: LlmProvider) {
    this.llm = llm;
  }

  /** @inheritdoc */
  async compress(memories: MemoryRecord[]): Promise<string> {
    return compressMemories(this.llm, memories);
  }
}

/**
 * Compress memories into one summary using an LLM chat completion.
 *
 * @param llm - LLM provider for the summarization call.
 * @param memories - Memories to collapse (must be non-empty).
 * @returns Plain-text summary preserving key facts.
 * @throws {@link CompressionError} when `memories` is empty or the LLM call fails.
 *
 * @example
 * ```ts
 * const summary = await compressMemories(llm, selectedMemories);
 * await wolbarg.compress({ agent, memoryIds, summary });
 * ```
 */
export async function compressMemories(
  llm: LlmProvider,
  memories: MemoryRecord[],
): Promise<string> {
  if (memories.length === 0) {
    throw new CompressionError("No memories available to compress");
  }

  const payload = memories
    .map((memory, index) => {
      const meta =
        Object.keys(memory.metadata).length > 0
          ? `\nMetadata: ${JSON.stringify(memory.metadata)}`
          : "";
      return `[${index + 1}] (id=${memory.id}, created=${memory.createdAt.toISOString()})${meta}\n${memory.content.text}`;
    })
    .join("\n\n");

  try {
    return await llm.complete([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Compress the following ${memories.length} memories into a single concise summary:\n\n${payload}`,
      },
    ]);
  } catch (error) {
    if (error instanceof CompressionError) {
      throw error;
    }
    throw new CompressionError(
      `Compression failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Factory for the default LLM-backed {@link CompressionProvider}.
 *
 * @param llm - LLM used for summarization.
 * @returns A {@link CompressionProvider} named `"llm"`.
 */
export function createCompressionProvider(
  llm: LlmProvider,
): CompressionProvider {
  return new LlmCompressionProvider(llm);
}
