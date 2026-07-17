/**
 * Wolbarg — local-first, model-agnostic semantic memory SDK for AI agents.
 *
 * @packageDocumentation
 */

export { Wolbarg, wolbarg } from "./core/wolbarg.js";

export type {
  ClearOptions,
  CompressOptions,
  CompressResult,
  CheckpointInfo,
  CheckpointOptions,
  DatabaseConfig,
  DatabaseProviderName,
  EmbeddingConfig,
  ExportResult,
  ForgetByFilterOptions,
  ForgetByIdOptions,
  ForgetOptions,
  HistoryEvent,
  HistoryOptions,
  HistoryResult,
  HybridConfig,
  ImportResult,
  IngestOptions,
  IngestResult,
  InitOptions,
  LlmConfig,
  MemoryContent,
  MemoryFilter,
  MemoryMetadata,
  MemoryRecord,
  MetadataComparison,
  MetadataFilter,
  MmrConfig,
  PostgresDatabaseConfig,
  RecallExplainResponse,
  RecallExplanationHit,
  RecallOptions,
  RecallResult,
  RememberOptions,
  RetrievalConfig,
  SqliteDatabaseConfig,
  StatsResult,
  StorageConfig,
  StorageProviderName,
  TelemetryConfig,
} from "./types/index.js";

export type {
  WolbargOptions,
  WolbargOptionsWithLlm,
  WolbargOptionsWithoutLlm,
} from "./core/options.js";

export {
  WolbargError,
  CompressionError,
  ConfigurationError,
  DatabaseError,
  EmbeddingError,
  InitializationError,
  MemoryNotFoundError,
  ProviderNotConfiguredError,
  ValidationError,
  wrapOperationError,
} from "./errors/index.js";

export { meta } from "./filters/index.js";
export type { MetadataFilter as MetaFilter } from "./filters/index.js";

export {
  sqlite,
  sqliteConfig,
  postgres,
  postgresConfig,
  sqliteTelemetry,
  sqliteCheckpoint,
  createTelemetryProvider,
  wolbarg as createWolbarg,
} from "./factories/index.js";

export {
  createEmbeddingProvider,
  openaiCompatibleEmbedding,
  openaiEmbedding,
  ollamaEmbedding,
  openRouterEmbedding,
  lmStudioEmbedding,
  geminiEmbedding,
  togetherEmbedding,
  vllmEmbedding,
} from "./embedding/index.js";
export type { EmbeddingProvider } from "./embedding/index.js";

export {
  createLlmProvider,
  openaiCompatibleLlm,
  openaiLlm,
  ollamaLlm,
  openRouterLlm,
} from "./llm/index.js";
export type { LlmProvider, ChatMessage } from "./llm/index.js";

export {
  createStorageProvider,
  createDatabaseProvider,
  SqliteStorageProvider,
  SqliteDatabaseProvider,
  PostgresStorageProvider,
} from "./storage/index.js";
export type {
  StorageProvider,
  DatabaseProvider,
} from "./storage/index.js";

export { bm25 } from "./keyword/index.js";
export type {
  KeywordSearchProvider,
  KeywordSearchHit,
  KeywordDocument,
} from "./keyword/index.js";

export {
  jinaReranker,
  cohereReranker,
  bgeReranker,
  crossEncoder,
  openaiReranker,
} from "./rerank/index.js";
export type {
  RerankerProvider,
  RerankDocument,
  RerankHit,
} from "./rerank/index.js";

export { tesseract } from "./ocr/index.js";
export type { OCRProvider, OcrResult } from "./ocr/index.js";

export { geminiVision, openaiVision } from "./vision/index.js";
export type { VisionProvider, VisionResult } from "./vision/index.js";

export {
  createChunkingStrategy,
  FixedChunkingStrategy,
  SentenceChunkingStrategy,
  ParagraphChunkingStrategy,
  MarkdownChunkingStrategy,
  HeadingChunkingStrategy,
} from "./chunking/index.js";
export type { ChunkingStrategy, Chunk, ChunkingOptions } from "./chunking/index.js";

export {
  createCompressionProvider,
  LlmCompressionProvider,
} from "./compression/index.js";
export type { CompressionProvider } from "./compression/index.js";

export type {
  MemoryProvider,
  TelemetryProvider,
  CheckpointProvider,
  CheckpointMeta,
  CreateCheckpointOptions,
  EventDatabase,
} from "./providers/interfaces/index.js";

export {
  SqliteTelemetryProvider,
  SqliteCheckpointProvider,
  SqliteEventDatabase,
} from "./providers/sqlite/index.js";

export type {
  TelemetryOperation,
  TelemetryStatus,
  TelemetryLogLevel,
  LatencyBreakdown,
  StageSpan,
  PersistedRecallExplainPayload,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "./telemetry/index.js";

export { TelemetryEmitter, NoopTelemetryProvider, WolbargLogger } from "./telemetry/index.js";

export type { BenchmarkSample, BenchmarkReport } from "./benchmark/index.js";
export { runBenchmark, summarizeBenchmark } from "./benchmark/index.js";
