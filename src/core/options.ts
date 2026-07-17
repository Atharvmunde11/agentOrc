/**
 * Constructor options for Wolbarg v0.3.
 */

import type { ChunkingStrategy } from "../chunking/index.js";
import type { CompressionProvider } from "../compression/index.js";
import type { EmbeddingProvider } from "../embedding/index.js";
import type { KeywordSearchProvider } from "../keyword/index.js";
import type { LlmProvider } from "../llm/index.js";
import type { OCRProvider } from "../ocr/index.js";
import type { RerankerProvider } from "../rerank/index.js";
import type { StorageProvider } from "../storage/types.js";
import type { CheckpointProvider } from "../providers/interfaces/CheckpointProvider.js";
import type { TelemetryProvider } from "../providers/interfaces/TelemetryProvider.js";
import type {
  DatabaseConfig,
  EmbeddingConfig,
  LlmConfig,
  RetrievalConfig,
  StorageConfig,
  TelemetryConfig,
} from "../types/index.js";
import type { VisionProvider } from "../vision/index.js";

export type EmbeddingInput = EmbeddingProvider | EmbeddingConfig;
export type LlmInput = LlmProvider | LlmConfig;
export type StorageInput = StorageProvider | StorageConfig | DatabaseConfig;

export interface WolbargOptionsBase {
  /** Organization namespace isolating memories within a shared database. */
  organization: string;
  /**
   * Storage provider instance or config.
   * Prefer `database` in v0.3 docs; `storage` remains fully supported.
   */
  storage?: StorageInput;
  /**
   * v0.3 alias for `storage`. Accepts `{ provider, url }` or `{ provider, connectionString }`.
   */
  database?: StorageInput;
  /** Embedding provider instance or config. */
  embedding: EmbeddingInput;
  /** Optional independent telemetry system (separate database). */
  telemetry?: TelemetryConfig | TelemetryProvider;
  /** Optional checkpoint provider override (defaults to SQLite when file-backed). */
  checkpoint?: CheckpointProvider;
  /** Optional directory for SQLite checkpoints. */
  checkpointDirectory?: string;
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

export function isTelemetryProvider(
  value: TelemetryConfig | TelemetryProvider,
): value is TelemetryProvider {
  return typeof (value as TelemetryProvider).emit === "function";
}

/** Resolve connection path from url or connectionString. */
export function resolveDatabaseUrl(
  config: DatabaseConfig | StorageConfig,
): string {
  const url =
    ("url" in config && config.url) ||
    ("connectionString" in config && config.connectionString) ||
    "";
  return typeof url === "string" ? url : "";
}
