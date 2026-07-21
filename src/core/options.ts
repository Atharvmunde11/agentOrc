/**
 * Constructor options for Wolbarg (v0.5.5).
 *
 * Pass **provider instances** (custom implementations of the interfaces) or
 * **config objects / factory helpers**. Discriminated at runtime via
 * {@link isEmbeddingProvider}, {@link isLlmProvider}, {@link isStorageProvider},
 * {@link isTelemetryProvider}, and {@link isGraphProvider}.
 */

import type { ChunkingStrategy } from "../chunking/index.js";
import type { CompressionProvider } from "../compression/index.js";
import type { EmbeddingProvider } from "../embedding/index.js";
import type { GraphConfig, GraphProvider } from "../graph/types.js";
import type { KeywordSearchProvider } from "../keyword/index.js";
import type { LlmProvider } from "../llm/index.js";
import type { OCRProvider } from "../ocr/index.js";
import type { RerankerProvider } from "../rerank/index.js";
import type { StorageProvider } from "../storage/types.js";
import type { CheckpointProvider } from "../providers/interfaces/CheckpointProvider.js";
import type { TelemetryProvider } from "../providers/interfaces/TelemetryProvider.js";
import type {
  ConcurrencyConfig,
  DatabaseConfig,
  EmbeddingCacheConfig,
  EmbeddingConfig,
  LlmConfig,
  MemoryDedupeConfig,
  RetrievalConfig,
  StorageConfig,
  TelemetryConfig,
} from "../types/index.js";
import type { VisionProvider } from "../vision/index.js";

/**
 * Embedding input: a live {@link EmbeddingProvider} **or** an
 * {@link EmbeddingConfig} / factory result (`openaiEmbedding(...)`, etc.).
 *
 * Custom provider example:
 * ```ts
 * const embedding: EmbeddingProvider = {
 *   model: "custom",
 *   embed: async (text) => { /* return Float32Array *\/ },
 *   validate: async () => ({ dimensions: 768 }),
 * };
 * ```
 */
export type EmbeddingInput = EmbeddingProvider | EmbeddingConfig;

/**
 * LLM input: a live {@link LlmProvider} **or** an {@link LlmConfig} /
 * factory result (`openaiLlm(...)`, `ollamaLlm(...)`, etc.).
 *
 * Required for {@link Wolbarg.compress} and `rememberFromMessages({ mode: "extract" })`.
 *
 * Custom provider example:
 * ```ts
 * const llm: LlmProvider = {
 *   model: "my-model",
 *   complete: async (messages) => { /* return assistant text *\/ },
 *   validate: async () => { /* ping endpoint *\/ },
 * };
 * ```
 */
export type LlmInput = LlmProvider | LlmConfig;

/**
 * Storage input: a live {@link StorageProvider} **or** a
 * {@link StorageConfig} / {@link DatabaseConfig} (`{ provider: "sqlite", url }`).
 */
export type StorageInput = StorageProvider | StorageConfig | DatabaseConfig;

/**
 * Graph input: a live {@link GraphProvider} **or** a {@link GraphConfig}
 * (`sqliteGraph({ path })` / `neo4jGraph({ url, username, password })`).
 */
export type GraphInput = GraphProvider | GraphConfig;

/**
 * Shared constructor fields (with or without LLM).
 */
export interface WolbargOptionsBase {
  /** Organization namespace isolating memories within a shared database. */
  organization: string;
  /**
   * Storage provider instance or config.
   * Prefer `database` in docs; `storage` remains fully supported.
   */
  storage?: StorageInput;
  /**
   * Alias for `storage`. Accepts `{ provider, url }` or `{ provider, connectionString }`,
   * or a custom {@link StorageProvider}.
   */
  database?: StorageInput;
  /**
   * Embedding provider instance or config.
   * Use {@link openaiEmbedding} / {@link ollamaEmbedding} / etc., raw
   * {@link EmbeddingConfig}, or any custom {@link EmbeddingProvider}.
   */
  embedding: EmbeddingInput;
  /**
   * Optional independent telemetry system (separate database or custom
   * {@link TelemetryProvider}).
   */
  telemetry?: TelemetryConfig | TelemetryProvider;
  /** Optional checkpoint provider override (defaults to SQLite when file-backed). */
  checkpoint?: CheckpointProvider;
  /** Optional directory for SQLite checkpoints. */
  checkpointDirectory?: string;
  /**
   * Optional reranker — skipped when absent.
   * Implement {@link RerankerProvider} or use `jinaReranker` / `cohereReranker` / etc.
   */
  reranker?: RerankerProvider;
  /**
   * Optional keyword search — enables hybrid recall when present.
   * Implement {@link KeywordSearchProvider} or use {@link bm25}.
   */
  keywordSearch?: KeywordSearchProvider;
  /**
   * Optional OCR for image ingest.
   * Implement {@link OCRProvider} or use {@link tesseract}.
   */
  ocr?: OCRProvider;
  /**
   * Optional vision model for image captions during ingest.
   * Implement {@link VisionProvider} or use {@link openaiVision} / {@link geminiVision}.
   */
  vision?: VisionProvider;
  /**
   * Optional graph memory layer (SQLite embedded or Neo4j networked).
   * Fully optional — omitting it does not change existing memory behavior.
   * Accepts a {@link GraphProvider} instance or a recognized config shape.
   */
  graph?: GraphInput;
  /**
   * Optional compression provider (overrides the default LLM-backed compressor).
   * Implement {@link CompressionProvider} for a fully custom compress pipeline.
   */
  compression?: CompressionProvider;
  /**
   * Optional default chunking strategy for ingest.
   * Implement {@link ChunkingStrategy} or use `createChunkingStrategy(...)`.
   */
  chunking?: ChunkingStrategy;
  /** Optional retrieval defaults (over-fetch, hybrid weights, MMR). */
  retrieval?: RetrievalConfig;
  /** SQLite multi-writer concurrency tuning (ignored for Postgres). */
  concurrency?: ConcurrencyConfig;
  /** Transparent embedding cache (default enabled). */
  embeddingCache?: EmbeddingCacheConfig;
  /** Memory write-path options (dedupe / upsert). */
  memory?: {
    /** Exact / near-duplicate detection on remember. See {@link MemoryDedupeConfig}. */
    dedupe?: MemoryDedupeConfig;
  };
}

/**
 * Options when no LLM is configured (`compress` / extract mode unavailable).
 */
export interface WolbargOptionsWithoutLlm extends WolbargOptionsBase {
  llm?: undefined;
}

/**
 * Options when an LLM is configured (enables {@link Wolbarg.compress}).
 */
export interface WolbargOptionsWithLlm extends WolbargOptionsBase {
  /**
   * Chat model used for compression and extract-mode rememberFromMessages.
   * Pass a custom {@link LlmProvider} (`complete` + `validate`) or a config /
   * factory such as {@link openaiLlm} / {@link ollamaLlm} /
   * {@link openaiCompatibleLlm}.
   */
  llm: LlmInput;
}

/** Discriminated union of constructor options. */
export type WolbargOptions =
  | WolbargOptionsWithoutLlm
  | WolbargOptionsWithLlm;

/**
 * Type guard: value is a live {@link EmbeddingProvider} (has `embed`).
 *
 * @param value - Embedding config or provider instance.
 * @returns `true` when `value.embed` is a function.
 */
export function isEmbeddingProvider(
  value: EmbeddingInput,
): value is EmbeddingProvider {
  return typeof (value as EmbeddingProvider).embed === "function";
}

/**
 * Type guard: value is a live {@link LlmProvider} (has `complete`).
 *
 * @param value - LLM config or provider instance.
 * @returns `true` when `value.complete` is a function.
 */
export function isLlmProvider(value: LlmInput): value is LlmProvider {
  return typeof (value as LlmProvider).complete === "function";
}

/**
 * Type guard: value is a live {@link StorageProvider} (has `open`).
 *
 * @param value - Storage/database config or provider instance.
 * @returns `true` when `value.open` is a function.
 */
export function isStorageProvider(
  value: StorageInput,
): value is StorageProvider {
  return typeof (value as StorageProvider).open === "function";
}

/**
 * Type guard: value is a live {@link TelemetryProvider} (has `emit`).
 *
 * @param value - Telemetry config or provider instance.
 * @returns `true` when `value.emit` is a function.
 */
export function isTelemetryProvider(
  value: TelemetryConfig | TelemetryProvider,
): value is TelemetryProvider {
  return typeof (value as TelemetryProvider).emit === "function";
}

/**
 * Type guard: value is a live {@link GraphProvider}.
 *
 * @param value - Graph config or provider instance.
 * @returns `true` when `open`, `linkMemories`, and `getRelated` are functions.
 */
export function isGraphProvider(value: GraphInput): value is GraphProvider {
  return (
    typeof (value as GraphProvider).open === "function" &&
    typeof (value as GraphProvider).linkMemories === "function" &&
    typeof (value as GraphProvider).getRelated === "function"
  );
}

/**
 * Resolve connection path from `url` or `connectionString` on a DB config.
 *
 * @param config - Database or storage config object.
 * @returns Non-empty connection string/path, or `""` if neither field is set.
 */
export function resolveDatabaseUrl(
  config: DatabaseConfig | StorageConfig,
): string {
  const url =
    ("url" in config && config.url) ||
    ("connectionString" in config && config.connectionString) ||
    "";
  return typeof url === "string" ? url : "";
}
