/**
 * Public configuration and domain types for Wolbarg v0.3.
 */

import type { MetadataFilter } from "../filters/types.js";
import type { TelemetryConfig } from "../telemetry/types.js";

/** Opaque, user-defined metadata. Never validated or modified by the SDK. */
export type MemoryMetadata = Record<string, unknown>;

/** Memory content payload. */
export interface MemoryContent {
  /** Plain-text content used for embedding generation. */
  text: string;
}

/** Supported storage / database providers. */
export type DatabaseProviderName = "sqlite" | "postgres";

/** @deprecated Prefer `StorageProviderName`. */
export type StorageProviderName = DatabaseProviderName;

/** SQLite database configuration. */
export interface SqliteDatabaseConfig {
  provider: "sqlite";
  /**
   * Path to the SQLite database file, or `:memory:` for an in-memory database.
   * Relative paths are resolved from `process.cwd()`.
   * Prefer `url` in v0.3; `connectionString` remains supported.
   */
  connectionString?: string;
  /** v0.3 preferred alias for the SQLite path / connection. */
  url?: string;
}

/** PostgreSQL database configuration. */
export interface PostgresDatabaseConfig {
  provider: "postgres";
  /** Postgres connection string (e.g. `postgres://user:pass@host:5432/db`). */
  connectionString?: string;
  /** v0.3 preferred alias for the Postgres connection string. */
  url?: string;
  /** Optional max pool size. Defaults to 64. */
  maxPoolSize?: number;
  /** When false, uses asynchronous commit for higher write throughput. */
  durableWrites?: boolean;
}

/** Discriminated union of database configs. */
export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

/** Alias used by the constructor-based API. */
export type StorageConfig = DatabaseConfig;

export type { TelemetryConfig };

/**
 * OpenAI-compatible embedding endpoint configuration.
 * Works with OpenAI, Ollama, LM Studio, OpenRouter, Azure OpenAI, Gemini, etc.
 */
export interface EmbeddingConfig {
  /** Base URL of the OpenAI-compatible API (e.g. `https://api.openai.com/v1`). */
  baseUrl: string;
  /** API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Embedding model identifier. */
  model: string;
  /** Optional request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
}

/**
 * OpenAI-compatible chat completion endpoint used for compression.
 * May differ from the embedding provider.
 */
export interface LlmConfig {
  /** Base URL of the OpenAI-compatible API. */
  baseUrl: string;
  /** API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Chat model identifier. */
  model: string;
  /** Sampling temperature. Defaults to 0.2. */
  temperature?: number;
  /** Maximum tokens for the completion. Defaults to 4096. */
  maxTokens?: number;
  /** Optional request timeout in milliseconds. Defaults to 60_000. */
  timeoutMs?: number;
}

/** Hybrid score fusion weights. */
export interface HybridConfig {
  /** Weight for semantic similarity. Defaults to 0.7. */
  semanticWeight?: number;
  /** Weight for keyword relevance. Defaults to 0.3. */
  keywordWeight?: number;
}

/** MMR diversification options. */
export interface MmrConfig {
  /** Trade-off between relevance and diversity (0–1). Defaults to 0.5. */
  lambda?: number;
}

/** Retrieval pipeline defaults applied when constructing Wolbarg. */
export interface RetrievalConfig {
  /** Default over-fetch multiplier for candidate generation. Defaults to 2 (no filters) or 4 (with metadata filters). */
  overFetchFactor?: number;
  /** Default hybrid fusion weights. */
  hybrid?: HybridConfig;
  /** Default MMR lambda. */
  mmr?: MmrConfig;
}

/**
 * Full SDK initialization options (v0.1 compat + v0.2 extensions).
 * Prefer the constructor API with `storage` / provider instances.
 */
export interface InitOptions {
  /** Organization namespace isolating memories within a shared database. */
  organization: string;
  /** Database provider configuration. */
  database: DatabaseConfig;
  /** Embedding provider configuration. */
  embedding: EmbeddingConfig;
  /**
   * LLM provider configuration used for compression.
   * Optional in v0.2 — required only when calling `compress`.
   */
  llm?: LlmConfig;
}

/** Write-time memory dedupe strategy. */
export type MemoryDedupeStrategy = "exact" | "near" | "exact-or-near";

/** Constructor / per-call memory dedupe configuration. */
export interface MemoryDedupeConfig {
  enabled?: boolean;
  strategy?: MemoryDedupeStrategy;
  /** Cosine similarity threshold for near-dup matching. Default 0.92 */
  nearThreshold?: number;
  /** Max vector candidates considered for near-dup. Default 8 */
  nearCandidateLimit?: number;
}

/** SQLite multi-writer concurrency tuning. */
export interface ConcurrencyConfig {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  lockTimeoutMs?: number;
}

/** Transparent embedding cache configuration. */
export interface EmbeddingCacheConfig {
  enabled?: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

/** Input for {@link Wolbarg.remember}. */
export interface RememberOptions {
  /** Agent identifier that owns this memory. */
  agent: string;
  /** Content to store and embed. */
  content: MemoryContent;
  /** Optional opaque metadata. Stored and returned as-is. */
  metadata?: MemoryMetadata;
  /** Per-call dedupe override; undefined uses constructor `memory.dedupe`. */
  dedupe?: boolean | MemoryDedupeConfig;
}

/**
 * Chat turn for {@link Wolbarg.rememberFromMessages}.
 * @experimental until 1.0
 */
export interface ConversationMessage {
  role: string;
  content: string;
}

/** How `mode: "raw"` selects user turns to store. */
export type RememberFromMessagesRawStrategy = "last_user" | "all_user";

/**
 * Options for {@link Wolbarg.rememberFromMessages}.
 * @experimental until 1.0
 */
export interface RememberFromMessagesOptions {
  /** Agent identifier that owns the stored memories. */
  agent: string;
  /**
   * `raw` (default) — store user message text without an LLM.
   * `extract` — use configured `llm` to extract atomic facts, then remember each.
   */
  mode?: "raw" | "extract";
  /** Used when `mode` is `raw`. Defaults to `last_user`. */
  rawStrategy?: RememberFromMessagesRawStrategy;
  /** Optional opaque metadata attached to every stored memory. */
  metadata?: MemoryMetadata;
  /** Per-call dedupe override; undefined uses constructor `memory.dedupe`. */
  dedupe?: boolean | MemoryDedupeConfig;
}

/** Whether remember created a new row or updated an existing one. */
export type RememberAction = "created" | "updated";

/** Result of {@link Wolbarg.remember} — MemoryRecord plus upsert action. */
export interface RememberResult extends MemoryRecord {
  action: RememberAction;
}

/** Optional filter applied to recall / forget / compress operations. */
export interface MemoryFilter {
  /** Restrict results to a specific agent. */
  agent?: string;
  /**
   * When `true`, include archived memories.
   * Defaults to `false` for recall and compress.
   */
  includeArchived?: boolean;
  /** Structured metadata filter (AND/OR/NOT + comparisons). */
  metadata?: MetadataFilter;
}

/** Input for {@link Wolbarg.recall}. */
export interface RecallOptions {
  /** Natural-language query to embed and search against. */
  query: string;
  /** Maximum number of results to return. Defaults to 5. */
  topK?: number;
  /**
   * Minimum cosine similarity (0–1) required for a result.
   * Defaults to `0` (no threshold).
   */
  threshold?: number;
  /** Optional filters. */
  filter?: MemoryFilter;
  /**
   * When `true`, apply the configured reranker if available.
   * Skips silently when no reranker is configured.
   */
  rerank?: boolean;
  /** Enable MMR diversification. */
  mmr?: boolean | MmrConfig;
  /**
   * Enable hybrid (semantic + keyword) search when a keyword provider exists.
   * Falls back to semantic-only when keyword search is not configured.
   */
  hybrid?: boolean | HybridConfig;
  /**
   * When `true`, return enriched explain results instead of plain RecallResult[].
   */
  explain?: boolean;
  /**
   * When `true` and a graph provider is configured, each hit includes
   * `related` memories from {@link GraphProvider.getRelated}.
   * Omitted / false → no behavior change (related is absent).
   */
  includeGraph?: boolean;
}

/** A single recalled memory with similarity score. */
export interface RecallResult {
  id: string;
  organization: string;
  agent: string;
  content: MemoryContent;
  metadata: MemoryMetadata;
  archived: boolean;
  similarity: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Present only when `recall({ includeGraph: true })` and a graph provider
   * is configured. Related memories via graph traversal (depth 1, both dirs).
   */
  related?: MemoryRecord[];
}

/** Enriched recall hit when `explain: true`. */
export interface RecallExplanationHit {
  memory: RecallResult;
  score: number;
  distance: number;
  rankingReason: string;
  matchedFields: string[];
  metadataMatch: boolean;
  providerUsed: string;
  searchTime: number;
  rankingTime: number;
}

/** Full explain-mode response. */
export interface RecallExplainResponse {
  results: RecallExplanationHit[];
  providerUsed: string;
  searchTime: number;
  rankingTime: number;
  totalTime: number;
  traceId: string;
}

/** Options for creating a named checkpoint. */
export interface CheckpointOptions {
  description?: string;
}

/** Checkpoint metadata returned by checkpoint APIs. */
export interface CheckpointInfo {
  name: string;
  description: string | null;
  createdAt: string;
  sdkVersion: string;
  provider: string;
  snapshotPath: string;
  sourcePath: string;
  sizeBytes: number;
}

/** Result of export(). */
export interface ExportResult {
  path: string;
  sizeBytes: number;
  exportedAt: string;
}

/** Result of import(). */
export interface ImportResult {
  path: string;
  importedAt: string;
}

/** Persisted memory record (without embedding vector). */
export interface MemoryRecord {
  id: string;
  organization: string;
  agent: string;
  content: MemoryContent;
  metadata: MemoryMetadata;
  archived: boolean;
  /** ID of the summary memory this was compressed into, if any. */
  compressedInto: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for {@link Wolbarg.compress}. */
export interface CompressOptions {
  /** Agent whose memories should be compressed. */
  agent: string;
  /**
   * Maximum number of active memories to include in compression.
   * Defaults to 50.
   */
  limit?: number;
}

/** Result of a successful compression. */
export interface CompressResult {
  /** Newly created summary memory. */
  summary: MemoryRecord;
  /** IDs of memories that were archived. */
  archivedIds: string[];
}

/** Forget by exact memory ID. */
export interface ForgetByIdOptions {
  id: string;
  filter?: never;
}

/** Forget by filter (e.g. all memories for an agent). */
export interface ForgetByFilterOptions {
  id?: never;
  filter: MemoryFilter & { agent: string };
}

/** Input for {@link Wolbarg.forget}. */
export type ForgetOptions = ForgetByIdOptions | ForgetByFilterOptions;

/** Input for {@link Wolbarg.history}. */
export interface HistoryOptions {
  /** Memory ID whose lineage should be returned. */
  id: string;
}

/** A single event in a memory's history. */
export interface HistoryEvent {
  id: string;
  memoryId: string;
  eventType: "created" | "archived" | "compressed" | "updated";
  relatedMemoryId: string | null;
  createdAt: Date;
}

/** Full history response for a memory. */
export interface HistoryResult {
  memory: MemoryRecord;
  events: HistoryEvent[];
}

/** Input for {@link Wolbarg.clear}. */
export interface ClearOptions {
  /**
   * Must be `true` to confirm irreversible deletion of all memories
   * in the current organization.
   */
  confirm: true;
}

/** Aggregate statistics for the current organization. */
export interface StatsResult {
  /**
   * Total memory rows including archived (historical) memories.
   * Prefer {@link activeMemories} for “live set” size.
   */
  totalMemories: number;
  /** Non-archived memories currently eligible for recall / compression. */
  activeMemories: number;
  /** Soft-archived memories retained for lineage after compression. */
  archivedMemories: number;
  totalAgents: number;
  databaseSizeBytes: number;
  embeddingModel: string;
  /** Configured LLM model, or `null` when compression is not configured. */
  llmModel: string | null;
  organization: string;
  embeddingDimensions: number;
}

/** Supported document input for {@link Wolbarg.ingest}. */
export interface IngestOptions {
  /** Agent that owns the ingested chunks. */
  agent: string;
  /**
   * File path, Buffer, or raw text content.
   * When `text` is provided, parsing is skipped.
   */
  source:
    | { path: string; mimeType?: string }
    | { buffer: Buffer; filename?: string; mimeType?: string }
    | { text: string; filename?: string };
  /** Optional metadata attached to every produced chunk memory. */
  metadata?: MemoryMetadata;
  /** Override chunking for this call. */
  chunking?: {
    strategy?: "fixed" | "sentence" | "paragraph" | "markdown" | "heading";
    chunkSize?: number;
    overlap?: number;
  };
}

/** Result of document ingestion. */
export interface IngestResult {
  /** Memory records created from document chunks. */
  memories: MemoryRecord[];
  /** Extracted text length before chunking. */
  extractedChars: number;
  /** Chunk count produced. */
  chunkCount: number;
  /** Whether OCR contributed text. */
  usedOcr: boolean;
  /** Whether vision contributed captions. */
  usedVision: boolean;
}

export type { MetadataFilter, MetadataComparison } from "../filters/types.js";
