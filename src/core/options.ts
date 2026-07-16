/**
 * Constructor options for Wolbarg v0.2.
 */

import type { ChunkingStrategy } from "../chunking/index.js";
import type { CompressionProvider } from "../compression/index.js";
import type { EmbeddingProvider } from "../embedding/index.js";
import type { KeywordSearchProvider } from "../keyword/index.js";
import type { LlmProvider } from "../llm/index.js";
import type { OCRProvider } from "../ocr/index.js";
import type { RerankerProvider } from "../rerank/index.js";
import type { StorageProvider } from "../storage/types.js";
import type {
  EmbeddingConfig,
  LlmConfig,
  RetrievalConfig,
  StorageConfig,
} from "../types/index.js";
import type { VisionProvider } from "../vision/index.js";

export type EmbeddingInput = EmbeddingProvider | EmbeddingConfig;
export type LlmInput = LlmProvider | LlmConfig;
export type StorageInput = StorageProvider | StorageConfig;

export interface WolbargOptionsBase {
  /** Organization namespace isolating memories within a shared database. */
  organization: string;
  /** Storage provider instance or config. */
  storage: StorageInput;
  /** Embedding provider instance or config. */
  embedding: EmbeddingInput;
  /** Optional reranker — skipped when absent. */
  reranker?: RerankerProvider;
  /** Optional keyword search — enables hybrid recall when present. */
  keywordSearch?: KeywordSearchProvider;
  /** Optional OCR for image ingest. */
  ocr?: OCRProvider;
  /** Optional vision model for image captions. */
  vision?: VisionProvider;
  /** Optional compression provider (overrides llm-backed default). */
  compression?: CompressionProvider;
  /** Optional default chunking strategy for ingest. */
  chunking?: ChunkingStrategy;
  /** Optional retrieval defaults. */
  retrieval?: RetrievalConfig;
}

export interface WolbargOptionsWithoutLlm extends WolbargOptionsBase {
  llm?: undefined;
}

export interface WolbargOptionsWithLlm extends WolbargOptionsBase {
  /** Chat model used for compression. */
  llm: LlmInput;
}

export type WolbargOptions =
  | WolbargOptionsWithoutLlm
  | WolbargOptionsWithLlm;

export function isEmbeddingProvider(
  value: EmbeddingInput,
): value is EmbeddingProvider {
  return typeof (value as EmbeddingProvider).embed === "function";
}

export function isLlmProvider(value: LlmInput): value is LlmProvider {
  return typeof (value as LlmProvider).complete === "function";
}

export function isStorageProvider(
  value: StorageInput,
): value is StorageProvider {
  return typeof (value as StorageProvider).open === "function";
}
