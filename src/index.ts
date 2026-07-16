/**
 * Wolbarg — local-first, model-agnostic semantic memory SDK for AI agents.
 *
 * @packageDocumentation
 */

export { Wolbarg } from "./core/wolbarg.js";

export type {
  ClearOptions,
  CompressOptions,
  CompressResult,
  DatabaseConfig,
  DatabaseProviderName,
  EmbeddingConfig,
  ForgetByFilterOptions,
  ForgetByIdOptions,
  ForgetOptions,
  HistoryEvent,
  HistoryOptions,
  HistoryResult,
  HybridConfig,
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
  RecallOptions,
  RecallResult,
  RememberOptions,
  RetrievalConfig,
  SqliteDatabaseConfig,
  StatsResult,
  StorageConfig,
  StorageProviderName,
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
} from "./errors/index.js";

export { meta } from "./filters/index.js";
export type { MetadataFilter as MetaFilter } from "./filters/index.js";

export { sqlite, sqliteConfig, postgres, postgresConfig } from "./factories/index.js";

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
