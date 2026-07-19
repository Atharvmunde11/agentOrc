/**
 * Wolbarg — modular semantic memory SDK for AI agents (v0.3).
 *
 * @example
 * ```ts
 * import { wolbarg, openaiEmbedding, openaiLlm } from "wolbarg";
 *
 * const ctx = wolbarg({
 *   organization: "my-org",
 *   database: { provider: "sqlite", url: "./memory.db" },
 *   embedding: openaiEmbedding({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "text-embedding-3-small",
 *   }),
 *   telemetry: {
 *     enabled: true,
 *     database: { provider: "sqlite", url: "./telemetry.db" },
 *     level: "debug",
 *   },
 * });
 *
 * await ctx.ready();
 * await ctx.remember({ agent: "research", content: { text: "…" } });
 * const hits = await ctx.recall({ query: "…", topK: 5 });
 * ```
 */

import fs from "node:fs";
import path from "node:path";

import {
  createCompressionProvider,
  type CompressionProvider,
} from "../compression/index.js";
import {
  createChunkingStrategy,
  inferChunkingStrategy,
  type ChunkingStrategy,
} from "../chunking/index.js";
import {
  createEmbeddingProvider,
  embedMany,
  type EmbeddingProvider,
} from "../embedding/index.js";
import {
  resolveEmbeddingCacheConfig,
  withEmbeddingCache,
  type ResolvedEmbeddingCacheConfig,
} from "../embedding/cache.js";
import {
  MemoryEmbeddingCacheStore,
  PostgresEmbeddingCacheStore,
  SqliteEmbeddingCacheStore,
} from "../embedding/cache-store.js";
import { createLlmProvider, type LlmProvider } from "../llm/index.js";
import { loadIngestSource, resolveParser } from "../ingest/index.js";
import type { KeywordSearchProvider } from "../keyword/index.js";
import type { OCRProvider } from "../ocr/index.js";
import type { RerankerProvider } from "../rerank/index.js";
import type { VisionProvider } from "../vision/index.js";
import { createStorageProvider } from "../storage/index.js";
import type { StorageProvider } from "../storage/types.js";
import type { MemoryRow } from "../storage/types.js";
import { matchesMetadata } from "../filters/match.js";
import {
  toHistoryEvent,
  toMemoryRecord,
  toRecallResult,
} from "../memory/index.js";
import {
  hashMemoryContent,
  mergeMemoryMetadata,
  resolveMemoryDedupeConfig,
  type ResolvedMemoryDedupeConfig,
} from "../memory/dedupe.js";
import {
  SqliteMemoryTransferProvider,
  type MemoryExportResult,
  type MemoryImportResult,
} from "../memory/transfer.js";
import {
  adaptiveFetchK,
  applyMmr,
  fuseScores,
  resolveHybridWeights,
  resolveMmr,
} from "../retrieval/index.js";
import {
  ConfigurationError,
  GraphCheckpointNotSupportedError,
  InitializationError,
  MemoryNotFoundError,
  ProviderNotConfiguredError,
  ValidationError,
  wrapOperationError,
} from "../errors/index.js";
import type {
  CheckpointInfo,
  CheckpointOptions,
  ClearOptions,
  CompressOptions,
  CompressResult,
  ExportResult,
  ForgetOptions,
  HistoryOptions,
  HistoryResult,
  ImportResult,
  IngestOptions,
  IngestResult,
  InitOptions,
  MemoryMetadata,
  MemoryRecord,
  RecallExplainResponse,
  RecallExplanationHit,
  RecallOptions,
  RecallResult,
  RememberOptions,
  RememberResult,
  RetrievalConfig,
  StatsResult,
} from "../types/index.js";
import type { GraphProvider, GetRelatedOptions } from "../graph/types.js";
import {
  AsyncMutex,
  assertFiniteNumber,
  assertNonEmptyString,
  createId,
  deserializeMetadata,
  distanceToSimilarity,
  nowIso,
} from "../utils/index.js";
import type {
  WolbargOptions,
  WolbargOptionsWithLlm,
  WolbargOptionsWithoutLlm,
} from "./options.js";
import {
  isEmbeddingProvider,
  isLlmProvider,
  isStorageProvider,
  isTelemetryProvider,
  resolveDatabaseUrl,
} from "./options.js";
import { validateWolbargOptions, validateInitOptions } from "./validate.js";
import {
  TelemetryEmitter,
} from "../telemetry/index.js";
import type { PersistedRecallExplainPayload } from "../telemetry/index.js";
import type { OperationTraceHandle } from "../telemetry/emitter.js";
import type { CheckpointProvider } from "../providers/interfaces/CheckpointProvider.js";
import { SqliteTelemetryProvider } from "../providers/sqlite/sqliteTelemetryProvider.js";
import { SqliteCheckpointProvider } from "../providers/sqlite/sqliteCheckpointProvider.js";
import { SqliteStorageProvider } from "../storage/providers/sqlite.js";
import { PostgresStorageProvider } from "../storage/providers/postgres.js";
import {
  SqliteSubscribeEmitter,
  createPostgresListenerFromPool,
  type MemoryChangeEvent,
  type SubscribeBackend,
  type SubscribeFilter,
  type Unsubscribe,
} from "../subscribe/index.js";

type ReadyState = {
  storage: StorageProvider;
  embedding: EmbeddingProvider;
  organization: string;
};

export class Wolbarg<HasLlm extends boolean = false> {
  declare readonly __hasLlm: HasLlm;

  private initialized = false;
  private booting: Promise<void> | null = null;
  private organization: string | null = null;
  private storage: StorageProvider | null = null;
  private embedding: EmbeddingProvider | null = null;
  private llm: LlmProvider | null = null;
  private compression: CompressionProvider | null = null;
  private reranker: RerankerProvider | null = null;
  private keywordSearch: KeywordSearchProvider | null = null;
  private ocr: OCRProvider | null = null;
  private vision: VisionProvider | null = null;
  private graph: GraphProvider | null = null;
  private chunking: ChunkingStrategy | null = null;
  private retrievalConfig: RetrievalConfig = {};
  private embeddingDimensions: number | null = null;
  private readonly writeMutex = new AsyncMutex();
  private telemetry: TelemetryEmitter;
  private checkpointProvider: CheckpointProvider | null = null;
  private memoryDbPath: string | null = null;
  private readonly transfer = new SqliteMemoryTransferProvider();
  private subscribeBackend: SubscribeBackend | null = null;
  private pgListenBackend: SubscribeBackend | null = null;
  private memoryDedupe: ResolvedMemoryDedupeConfig = resolveMemoryDedupeConfig();
  private embeddingCacheConfig: ResolvedEmbeddingCacheConfig =
    resolveEmbeddingCacheConfig();
  private rawEmbedding: EmbeddingProvider | null = null;

  constructor(options: WolbargOptionsWithLlm);
  constructor(options: WolbargOptionsWithoutLlm);
  constructor();
  constructor(options?: WolbargOptions) {
    this.telemetry = new TelemetryEmitter(null, { enabled: false, level: "off" });

    if (!options) {
      return;
    }

    const validated = validateWolbargOptions(options);
    this.organization = validated.organization;
    this.memoryDedupe = resolveMemoryDedupeConfig(validated.memory?.dedupe);
    this.embeddingCacheConfig = resolveEmbeddingCacheConfig(
      validated.embeddingCache,
    );

    const storageInput = validated.storage!;
    this.storage = isStorageProvider(storageInput)
      ? storageInput
      : createStorageProvider(storageInput, {
          concurrency: validated.concurrency,
        });

    if (!isStorageProvider(storageInput)) {
      this.memoryDbPath = resolveDatabaseUrl(storageInput);
    } else if (storageInput instanceof SqliteStorageProvider) {
      this.memoryDbPath = storageInput.path;
    }

    const embedding = isEmbeddingProvider(validated.embedding)
      ? validated.embedding
      : createEmbeddingProvider(validated.embedding);
    this.rawEmbedding = embedding;
    this.embedding = embedding;

    if (validated.llm) {
      this.llm = isLlmProvider(validated.llm)
        ? validated.llm
        : createLlmProvider(validated.llm);
      this.compression =
        validated.compression ?? createCompressionProvider(this.llm);
    } else {
      this.compression = validated.compression ?? null;
    }

    this.reranker = validated.reranker ?? null;
    this.keywordSearch = validated.keywordSearch ?? null;
    this.ocr = validated.ocr ?? null;
    this.vision = validated.vision ?? null;
    if (validated.graph) {
      this.graph = validated.graph as GraphProvider;
    }
    this.chunking = validated.chunking ?? null;
    this.retrievalConfig = validated.retrieval ?? {};

    // In-process subscribe backend (SQLite limitation: same process only).
    this.subscribeBackend = new SqliteSubscribeEmitter();

    if (validated.telemetry) {
      if (isTelemetryProvider(validated.telemetry)) {
        this.telemetry = new TelemetryEmitter(validated.telemetry, {
          enabled: true,
        }, { organization: validated.organization });
      } else {
        const url =
          validated.telemetry.database.url ??
          validated.telemetry.database.connectionString ??
          "";
        const provider = new SqliteTelemetryProvider({ url });
        this.telemetry = new TelemetryEmitter(provider, validated.telemetry, {
          organization: validated.organization,
        });
      }
    }

    this.checkpointProvider =
      validated.checkpoint ??
      new SqliteCheckpointProvider({
        directory: validated.checkpointDirectory,
      });
  }

  /**
   * Backwards-compatible initialization (v0.1 API).
   */
  async init(options: InitOptions): Promise<void> {
    if (this.initialized || this.storage) {
      throw new InitializationError("Wolbarg is already initialized");
    }

    let validated: InitOptions;
    try {
      validated = validateInitOptions(options);
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof ValidationError) {
        throw error;
      }
      throw new ConfigurationError(
        `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    this.organization = validated.organization;
    this.storage = createStorageProvider(validated.database);
    this.memoryDbPath = resolveDatabaseUrl(validated.database);
    this.embedding = createEmbeddingProvider(validated.embedding);
    if (validated.llm) {
      this.llm = createLlmProvider(validated.llm);
      this.compression = createCompressionProvider(this.llm);
    }
    if (!this.checkpointProvider) {
      this.checkpointProvider = new SqliteCheckpointProvider();
    }

    await this.ready();
  }

  /** Ensure storage (and optional telemetry) are open. */
  async ready(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.booting) {
      await this.booting;
      return;
    }
    this.booting = this.boot();
    try {
      await this.booting;
    } finally {
      this.booting = null;
    }
  }

  private async boot(): Promise<void> {
    if (!this.storage || !this.embedding || !this.organization) {
      throw new InitializationError(
        "Wolbarg is not configured. Pass options to the constructor or call init().",
      );
    }

    try {
      await this.storage.open();
      await this.telemetry.open();
      await this.checkpointProvider?.open();
      await this.graph?.open();

      // Wrap embedding with transparent cache after storage is open.
      if (this.rawEmbedding && this.embeddingCacheConfig.enabled) {
        if (this.storage instanceof SqliteStorageProvider) {
          const sqlite = this.storage;
          const store = new SqliteEmbeddingCacheStore(() => sqlite.getDatabase(), {
            ttlMs: this.embeddingCacheConfig.ttlMs,
          });
          this.embedding = withEmbeddingCache(
            this.rawEmbedding,
            store,
            this.embeddingCacheConfig,
          );
        } else if (this.storage instanceof PostgresStorageProvider) {
          // L1-only by default — durable cache must not share the insert pool
          // (that caused cache speedup <1x under concurrent unique writes).
          this.embedding = withEmbeddingCache(
            this.rawEmbedding,
            new PostgresEmbeddingCacheStore(() => null, {
              ttlMs: this.embeddingCacheConfig.ttlMs,
              durable: false,
            }),
            this.embeddingCacheConfig,
          );
        } else {
          this.embedding = withEmbeddingCache(
            this.rawEmbedding,
            new MemoryEmbeddingCacheStore({
              ttlMs: this.embeddingCacheConfig.ttlMs,
            }),
            this.embeddingCacheConfig,
          );
        }
      }

      // Postgres LISTEN is deferred until the first subscribe() — opening a
      // dedicated connection on every ready() dominated cold start (~50-100ms).
      if (this.storage instanceof PostgresStorageProvider) {
        // Listener is created lazily in subscribe().
      }

      if (this.storage instanceof SqliteStorageProvider) {
        this.storage.setRetryLogger((msg) => {
          // debug-level retry visibility
          if (typeof console !== "undefined" && console.debug) {
            console.debug(`[wolbarg] ${msg}`);
          }
        });
      }

      // Prefer stored dimensions — skip embedding round-trip on warm reopen.
      const storedDims = await this.storage.getEmbeddingDimensions();
      if (storedDims !== null && storedDims > 0) {
        await this.storage.ensureVectorSchema(storedDims);
        this.embeddingDimensions = storedDims;
      } else {
        const probe = await this.embedding.validate();
        await this.storage.ensureVectorSchema(probe.dimensions);
        this.embeddingDimensions = probe.dimensions;
      }
      this.initialized = true;
      this.telemetry.emitStartup(this.storage.name);
    } catch (error) {
      await this.graph?.close().catch(() => undefined);
      await this.storage.close().catch(() => undefined);
      await this.telemetry.close().catch(() => undefined);
      this.initialized = false;
      if (
        error instanceof ConfigurationError ||
        error instanceof InitializationError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new InitializationError(
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  /** Store a semantic memory for an agent (may upsert when dedupe is enabled). */
  async remember(options: RememberOptions): Promise<RememberResult> {
    const trace = this.telemetry.start("remember");
    try {
      const result = await this.rememberOne(options, trace);
      trace.success({
        provider: this.storage?.name,
        memoryIds: [result.id],
        returnedCount: 1,
        embeddingProvider: this.embedding?.model,
        model: this.embedding?.model,
        metadata: result.metadata,
        agentId: result.agent,
        tags: telemetryTags(result.metadata),
        extra: { upsertAction: result.action, action: result.action },
      });
      return result;
    } catch (error) {
      trace.failure(error, { agentId: options.agent });
      throw wrapOperationError("remember", error);
    }
  }

  /** Batch remember — sequential when dedupe enabled; otherwise one TX batch. */
  async rememberBatch(items: RememberOptions[]): Promise<RememberResult[]> {
    const parent = this.telemetry.start("rememberBatch");
    try {
      if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError("rememberBatch requires a non-empty array");
      }

      const anyDedupe = items.some((item) => {
        const cfg = resolveMemoryDedupeConfig(
          item.dedupe ?? this.memoryDedupe,
        );
        return cfg.enabled;
      }) || this.memoryDedupe.enabled;

      if (anyDedupe) {
        const out: RememberResult[] = [];
        for (const item of items) {
          const child = parent.child("remember");
          const result = await this.rememberOne(item, child);
          child.success({
            provider: this.storage?.name,
            memoryIds: [result.id],
            returnedCount: 1,
            metadata: result.metadata,
            agentId: result.agent,
            tags: telemetryTags(result.metadata),
            extra: { upsertAction: result.action },
          });
          out.push(result);
        }
        parent.success({
          provider: this.storage?.name,
          memoryIds: out.map((r) => r.id),
          returnedCount: out.length,
          embeddingProvider: this.embedding?.model,
          model: this.embedding?.model,
          agentId: commonAgent(items.map((item) => item.agent.trim())),
        });
        this.emitChange({
          event: "remember",
          organization: this.organization!,
          agent: commonAgent(items.map((i) => i.agent.trim())) ?? items[0]!.agent,
          memoryId: out.map((r) => r.id),
          timestamp: nowIso(),
          traceId: parent.context.traceId,
          sessionId: this.telemetry.sessionId,
        });
        return out;
      }

      const { storage, embedding, organization } = await this.requireReady();

      const tEmbed = performance.now();
      const texts = items.map((item, i) => {
        assertNonEmptyString(item.agent, `items[${i}].agent`);
        if (!item.content || typeof item.content.text !== "string") {
          throw new ValidationError(`items[${i}].content.text must be a string`);
        }
        assertNonEmptyString(item.content.text, `items[${i}].content.text`);
        return item.content.text;
      });
      const vectors = await embedMany(embedding, texts);
      parent.mark("embeddingMs", performance.now() - tEmbed);
      for (const vector of vectors) {
        this.assertEmbeddingDimensions(vector.length);
      }

      const timestamp = nowIso();
      const inputs = items.map((item, i) => ({
        id: createId(),
        organization,
        agent: item.agent.trim(),
        contentText: item.content.text,
        metadata: item.metadata ?? {},
        embedding: vectors[i]!,
        createdAt: timestamp,
        updatedAt: timestamp,
        contentHash: null, // batch path is append-only; dedupe uses sequential rememberOne
      }));

      for (let i = 0; i < inputs.length; i += 1) {
        const child = parent.child("remember");
        child.success({
          provider: storage.name,
          memoryIds: [inputs[i]!.id],
          returnedCount: 1,
          metadata: inputs[i]!.metadata,
          agentId: inputs[i]!.agent,
          tags: telemetryTags(inputs[i]!.metadata),
        });
      }

      const rows = await this.withWriteLock(async () => {
        const tStore = performance.now();
        const result = await storage.insertMemoriesBatch(inputs);
        parent.mark("databaseWriteMs", performance.now() - tStore);
        return result;
      });

      const records: RememberResult[] = rows.map((row) => ({
        ...toMemoryRecord(row),
        action: "created" as const,
      }));
      parent.success({
        provider: storage.name,
        memoryIds: records.map((r) => r.id),
        returnedCount: records.length,
        embeddingProvider: embedding.model,
        model: embedding.model,
        agentId: commonAgent(items.map((item) => item.agent.trim())),
      });
      this.emitChange({
        event: "remember",
        organization,
        agent: commonAgent(items.map((i) => i.agent.trim())) ?? items[0]!.agent,
        memoryId: records.map((r) => r.id),
        timestamp,
        traceId: parent.context.traceId,
        sessionId: this.telemetry.sessionId,
      });
      return records;
    } catch (error) {
      parent.failure(error);
      throw wrapOperationError("rememberBatch", error);
    }
  }

  /**
   * Update an existing memory by id (re-embeds when content changes).
   */
  async update(options: {
    id: string;
    content?: { text: string };
    metadata?: MemoryMetadata;
  }): Promise<RememberResult> {
    const trace = this.telemetry.start("remember");
    try {
      const { storage, embedding, organization } = await this.requireReady();
      assertNonEmptyString(options.id, "id");
      const existing = await storage.getMemoryById(options.id.trim(), organization);
      if (!existing) {
        throw new MemoryNotFoundError(`Memory not found: ${options.id}`);
      }

      const contentText = options.content?.text ?? existing.content_text;
      if (options.content) {
        assertNonEmptyString(options.content.text, "content.text");
      }
      const existingMeta = deserializeMetadata(existing.metadata_json);
      const metadata =
        options.metadata !== undefined
          ? mergeMemoryMetadata(existingMeta, options.metadata)
          : existingMeta;

      let vector: Float32Array | undefined;
      if (options.content !== undefined) {
        const tEmbed = performance.now();
        vector = await embedding.embed(contentText);
        trace.mark("embeddingMs", performance.now() - tEmbed);
        this.assertEmbeddingDimensions(vector.length);
      }

      const timestamp = nowIso();
      const row = await this.withWriteLock(async () => {
        const tStore = performance.now();
        const updated = await storage.updateMemory({
          id: existing.id,
          organization,
          contentText: options.content !== undefined ? contentText : undefined,
          metadata,
          embedding: vector,
          updatedAt: timestamp,
          contentHash:
            options.content !== undefined
              ? hashMemoryContent(contentText)
              : undefined,
        });
        trace.mark("databaseWriteMs", performance.now() - tStore);
        return updated;
      });
      if (!row) {
        throw new MemoryNotFoundError(`Memory not found: ${options.id}`);
      }
      const result: RememberResult = {
        ...toMemoryRecord(row),
        action: "updated",
      };
      this.emitChange({
        event: "update",
        organization,
        agent: result.agent,
        memoryId: result.id,
        timestamp,
        traceId: trace.context.traceId,
        sessionId: this.telemetry.sessionId,
        upsertAction: "updated",
      });
      trace.success({
        provider: storage.name,
        memoryIds: [result.id],
        returnedCount: 1,
        agentId: result.agent,
        extra: { upsertAction: "updated" },
      });
      return result;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("update", error);
    }
  }

  /**
   * Subscribe to memory change events.
   *
   * **SQLite:** delivers events only within this Node.js process.
   * A second process writing the same `memory.db` will not notify subscribers here.
   */
  subscribe(
    filter: SubscribeFilter,
    callback: (event: MemoryChangeEvent) => void,
  ): Unsubscribe {
    const org = filter.organization || this.organization;
    if (!org) {
      throw new ValidationError(
        "subscribe requires organization (set on Wolbarg or in filter)",
      );
    }
    const normalized: SubscribeFilter = {
      ...filter,
      organization: org,
    };

    // Postgres: lazy LISTEN — only open the dedicated connection on first subscribe.
    if (this.storage instanceof PostgresStorageProvider) {
      if (!this.pgListenBackend) {
        const pool = this.storage.getPool?.();
        if (pool) {
          this.pgListenBackend = createPostgresListenerFromPool(pool as never);
        }
      }
      if (this.pgListenBackend) {
        // subscribe() itself kicks ensureListening — do not also void start()
        // (that raced and leaked a second LISTEN client → duplicate events).
        return this.pgListenBackend.subscribe(normalized, callback);
      }
    }

    if (!this.subscribeBackend) {
      this.subscribeBackend = new SqliteSubscribeEmitter();
    }
    return this.subscribeBackend.subscribe(normalized, callback);
  }

  private emitChange(event: MemoryChangeEvent): void {
    try {
      if (this.storage instanceof PostgresStorageProvider) {
        // Avoid an extra pool round-trip when nobody is listening.
        const listener = this.pgListenBackend as
          | { hasSubscribers?: () => boolean }
          | null;
        if (listener?.hasSubscribers?.()) {
          void this.storage.notifyChange(event).catch((error) => {
            console.error(
              "[wolbarg] NOTIFY failed:",
              error instanceof Error ? error.message : error,
            );
          });
        }
        return;
      }
      this.subscribeBackend?.emit(event);
    } catch (error) {
      console.error(
        "[wolbarg] emitChange error:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Internal remember with optional upsert/dedupe. */
  private async rememberOne(
    options: RememberOptions,
    trace: OperationTraceHandle,
  ): Promise<RememberResult> {
    const { storage, embedding, organization } = await this.requireReady();
    assertNonEmptyString(options.agent, "agent");
    if (!options.content || typeof options.content.text !== "string") {
      throw new ValidationError("content.text must be a string");
    }
    assertNonEmptyString(options.content.text, "content.text");

    const metadata = options.metadata ?? {};
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new ValidationError("metadata must be a plain object when provided");
    }

    const agent = options.agent.trim();
    const text = options.content.text;
    const dedupe = resolveMemoryDedupeConfig(
      options.dedupe !== undefined ? options.dedupe : this.memoryDedupe,
    );

    const tEmbed = performance.now();
    const vector = await embedding.embed(text);
    trace.mark("embeddingMs", performance.now() - tEmbed);
    this.assertEmbeddingDimensions(vector.length);

    const timestamp = nowIso();
    const contentHash = hashMemoryContent(text);

    if (!dedupe.enabled) {
      const id = createId();
      const record = await this.withWriteLock(async () => {
        const tStore = performance.now();
        const row = await storage.insertMemory({
          id,
          organization,
          agent,
          contentText: text,
          metadata,
          embedding: vector,
          createdAt: timestamp,
          updatedAt: timestamp,
          // Null hash when dedupe is off — unique index allows duplicate text.
          contentHash: null,
        });
        trace.mark("databaseWriteMs", performance.now() - tStore);
        return toMemoryRecord(row);
      });
      this.emitChange({
        event: "remember",
        organization,
        agent,
        memoryId: record.id,
        timestamp,
        traceId: trace.context.traceId,
        sessionId: this.telemetry.sessionId,
        upsertAction: "created",
      });
      return { ...record, action: "created" };
    }

    // Exact match
    let existing: MemoryRow | null = null;
    if (
      dedupe.strategy === "exact" ||
      dedupe.strategy === "exact-or-near"
    ) {
      if (typeof storage.findActiveByContentHash === "function") {
        existing = await storage.findActiveByContentHash(
          organization,
          agent,
          contentHash,
        );
      }
    }

    if (existing) {
      const merged = mergeMemoryMetadata(
        deserializeMetadata(existing.metadata_json),
        metadata,
      );
      const row = await this.withWriteLock(async () => {
        const tStore = performance.now();
        const updated = await storage.updateMemory({
          id: existing!.id,
          organization,
          metadata: merged,
          updatedAt: timestamp,
          contentHash,
        });
        trace.mark("databaseWriteMs", performance.now() - tStore);
        return updated;
      }, { exclusive: true });
      const record = toMemoryRecord(row!);
      this.emitChange({
        event: "update",
        organization,
        agent,
        memoryId: record.id,
        timestamp,
        traceId: trace.context.traceId,
        sessionId: this.telemetry.sessionId,
        upsertAction: "updated",
      });
      return { ...record, action: "updated" };
    }

    // Near-dup
    if (
      dedupe.strategy === "near" ||
      dedupe.strategy === "exact-or-near"
    ) {
      const near = await this.findNearDuplicate(
        storage,
        organization,
        agent,
        vector,
        dedupe.nearThreshold,
        dedupe.nearCandidateLimit,
      );
      if (near) {
        const merged = mergeMemoryMetadata(
          deserializeMetadata(near.metadata_json),
          metadata,
        );
        const row = await this.withWriteLock(async () => {
          const tStore = performance.now();
          const updated = await storage.updateMemory({
            id: near.id,
            organization,
            contentText: text,
            metadata: merged,
            embedding: vector,
            updatedAt: timestamp,
            contentHash,
          });
          trace.mark("databaseWriteMs", performance.now() - tStore);
          return updated;
        }, { exclusive: true });
        const record = toMemoryRecord(row!);
        this.emitChange({
          event: "update",
          organization,
          agent,
          memoryId: record.id,
          timestamp,
          traceId: trace.context.traceId,
          sessionId: this.telemetry.sessionId,
          upsertAction: "updated",
        });
        return { ...record, action: "updated" };
      }
    }

    // Insert new
    const id = createId();
    try {
      const record = await this.withWriteLock(async () => {
        const tStore = performance.now();
        const row = await storage.insertMemory({
          id,
          organization,
          agent,
          contentText: text,
          metadata,
          embedding: vector,
          createdAt: timestamp,
          updatedAt: timestamp,
          contentHash,
        });
        trace.mark("databaseWriteMs", performance.now() - tStore);
        return toMemoryRecord(row);
      }, { exclusive: true });
      this.emitChange({
        event: "remember",
        organization,
        agent,
        memoryId: record.id,
        timestamp,
        traceId: trace.context.traceId,
        sessionId: this.telemetry.sessionId,
        upsertAction: "created",
      });
      return { ...record, action: "created" };
    } catch (error) {
      // Unique hash race: retry as update
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.toLowerCase().includes("unique") &&
        typeof storage.findActiveByContentHash === "function"
      ) {
        const raced = await storage.findActiveByContentHash(
          organization,
          agent,
          contentHash,
        );
        if (raced) {
          const merged = mergeMemoryMetadata(
            deserializeMetadata(raced.metadata_json),
            metadata,
          );
          const row = await this.withWriteLock(
            async () =>
              storage.updateMemory({
                id: raced.id,
                organization,
                metadata: merged,
                updatedAt: nowIso(),
                contentHash,
              }),
            { exclusive: true },
          );
          const record = toMemoryRecord(row!);
          this.emitChange({
            event: "update",
            organization,
            agent,
            memoryId: record.id,
            timestamp: nowIso(),
            upsertAction: "updated",
          });
          return { ...record, action: "updated" };
        }
      }
      throw error;
    }
  }

  private async findNearDuplicate(
    storage: StorageProvider,
    organization: string,
    agent: string,
    vector: Float32Array,
    threshold: number,
    limit: number,
  ): Promise<MemoryRow | null> {
    if (typeof storage.searchVectorsWithMemories === "function") {
      const hits = await storage.searchVectorsWithMemories(
        vector,
        limit,
        organization,
        { agent, includeArchived: false },
      );
      let best: { row: MemoryRow; sim: number } | null = null;
      for (const { row, distance } of hits) {
        if (row.archived === 1) continue;
        const sim = distanceToSimilarity(distance);
        if (sim >= threshold && (!best || sim > best.sim)) {
          best = { row, sim };
        }
      }
      return best?.row ?? null;
    }

    const hits = await storage.searchVectors(vector, limit);
    let best: { row: MemoryRow; sim: number } | null = null;
    for (const hit of hits) {
      const row = await storage.getMemoryByRowid(hit.memoryRowid, organization);
      if (!row || row.archived === 1 || row.agent !== agent) continue;
      const sim = distanceToSimilarity(hit.distance);
      if (sim >= threshold && (!best || sim > best.sim)) {
        best = { row, sim };
      }
    }
    return best?.row ?? null;
  }

  /**
   * Semantic / hybrid search over stored memories.
   * Pass `{ explain: true }` for enriched ranking diagnostics.
   */
  async recall(options: RecallOptions & { explain: true }): Promise<RecallExplainResponse>;
  async recall(options: RecallOptions & { explain?: false }): Promise<RecallResult[]>;
  async recall(options: RecallOptions): Promise<RecallResult[] | RecallExplainResponse>;
  async recall(options: RecallOptions): Promise<RecallResult[] | RecallExplainResponse> {
    const trace = this.telemetry.start("recall");
    const explain = options.explain === true;
    try {
      const { storage, embedding, organization } = await this.requireReady();
      assertNonEmptyString(options.query, "query");

      const topK = options.topK ?? 5;
      const threshold = options.threshold ?? 0;
      assertFiniteNumber(topK, "topK", { min: 1, max: 1000 });
      assertFiniteNumber(threshold, "threshold", { min: 0, max: 1 });

      const query = options.query.trim();
      const tEmbed = performance.now();
      const vector = await embedding.embed(query);
      trace.mark("embeddingMs", performance.now() - tEmbed);
      this.assertEmbeddingDimensions(vector.length);

      const hasFilters = Boolean(
        options.filter?.agent || options.filter?.metadata,
      );
      const overFetch =
        this.retrievalConfig.overFetchFactor ?? (hasFilters ? 4 : 2);
      const fetchK = adaptiveFetchK(topK, overFetch, hasFilters);

      const semanticScores = new Map<string, number>();
      const distances = new Map<string, number>();
      const byId = new Map<string, RecallResult>();
      const metadataMatched = new Map<string, boolean>();

      const tSearch = performance.now();
      const joined = storage.searchVectorsWithMemories;
      if (typeof joined === "function") {
        const joinedHits = await joined.call(
          storage,
          vector,
          fetchK,
          organization,
          {
            agent: options.filter?.agent,
            includeArchived: options.filter?.includeArchived,
          },
        );
        const tFilter = performance.now();
        for (const { row, distance } of joinedHits) {
          let metaOk = true;
          if (
            options.filter?.metadata &&
            !matchesMetadata(
              deserializeMetadata(row.metadata_json),
              options.filter.metadata,
            )
          ) {
            metaOk = false;
            continue;
          }
          const similarity = distanceToSimilarity(distance);
          if (similarity < threshold) {
            continue;
          }
          const result = toRecallResult(row, similarity);
          semanticScores.set(result.id, similarity);
          distances.set(result.id, distance);
          metadataMatched.set(result.id, metaOk);
          byId.set(result.id, result);
        }
        trace.mark("metadataFilteringMs", performance.now() - tFilter);
      } else {
        const hits = await storage.searchVectors(vector, fetchK);
        const rowids = hits.map((h) => h.memoryRowid);
        let rowMap: Map<number, MemoryRow>;
        if (typeof storage.getMemoriesByRowids === "function") {
          rowMap = await storage.getMemoriesByRowids(rowids, organization);
        } else {
          rowMap = new Map();
          const looked = await Promise.all(
            hits.map(async (hit) => ({
              hit,
              row: await storage.getMemoryByRowid(hit.memoryRowid, organization),
            })),
          );
          for (const { hit, row } of looked) {
            if (row) rowMap.set(hit.memoryRowid, row);
          }
        }

        const tFilter = performance.now();
        for (const hit of hits) {
          const row = rowMap.get(hit.memoryRowid);
          if (!row) continue;
          if (options.filter?.agent && row.agent !== options.filter.agent) continue;
          if (!options.filter?.includeArchived && row.archived === 1) continue;
          const metadata = deserializeMetadata(row.metadata_json);
          if (
            options.filter?.metadata &&
            !matchesMetadata(metadata, options.filter.metadata)
          ) {
            continue;
          }
          const similarity = distanceToSimilarity(hit.distance);
          if (similarity < threshold) continue;
          const result = toRecallResult(row, similarity);
          semanticScores.set(result.id, similarity);
          distances.set(result.id, hit.distance);
          metadataMatched.set(result.id, true);
          byId.set(result.id, result);
        }
        trace.mark("metadataFilteringMs", performance.now() - tFilter);
      }
      const searchTime = performance.now() - tSearch;
      trace.mark("vectorSearchMs", searchTime);
      trace.mark("databaseReadMs", searchTime);

      const hybridWeights =
        resolveHybridWeights(options.hybrid) ??
        (options.hybrid === undefined
          ? resolveHybridWeights(this.retrievalConfig.hybrid)
          : null);
      let keywordSignal: "enabled" | "disabled" | "unknown" = "disabled";

      if (hybridWeights) {
        let keywordScores = new Map<string, number>();

        if (typeof storage.searchKeyword === "function") {
          keywordSignal = "enabled";
          const ftsHits = await storage.searchKeyword(
            query,
            organization,
            fetchK,
          );
          keywordScores = new Map(ftsHits.map((h) => [h.memoryId, h.score]));
          const missingIds: string[] = [];
          for (const id of keywordScores.keys()) {
            if (!byId.has(id)) missingIds.push(id);
          }
          if (missingIds.length > 0) {
            const fetched = await Promise.all(
              missingIds.map((id) => storage.getMemoryById(id, organization)),
            );
            for (const row of fetched) {
              if (!row) continue;
              if (options.filter?.agent && row.agent !== options.filter.agent) {
                continue;
              }
              if (!options.filter?.includeArchived && row.archived === 1) {
                continue;
              }
              if (
                options.filter?.metadata &&
                !matchesMetadata(
                  deserializeMetadata(row.metadata_json),
                  options.filter.metadata,
                )
              ) {
                continue;
              }
              byId.set(row.id, toRecallResult(row, 0));
              metadataMatched.set(row.id, true);
            }
          }
        } else if (this.keywordSearch) {
          keywordSignal = "enabled";
          const corpus = await storage.listMemories(
            {
              organization,
              agent: options.filter?.agent,
              includeArchived: options.filter?.includeArchived,
              metadata: options.filter?.metadata,
            },
            Math.min(fetchK * 2, 2000),
          );
          const keywordHits = await this.keywordSearch.search(
            query,
            corpus.map((row) => ({ id: row.id, text: row.content_text })),
            fetchK,
          );
          keywordScores = new Map(
            keywordHits.map((h) => [h.memoryId, h.score]),
          );
          for (const row of corpus) {
            if (byId.has(row.id) || !keywordScores.has(row.id)) continue;
            byId.set(row.id, toRecallResult(row, 0));
            metadataMatched.set(row.id, true);
          }
        }

        if (keywordScores.size > 0) {
          const fused = fuseScores(semanticScores, keywordScores, hybridWeights);
          for (const [id, score] of fused) {
            const existing = byId.get(id);
            if (existing) {
              byId.set(id, { ...existing, similarity: score });
            }
          }
        }
      }

      const tRank = performance.now();
      let results = [...byId.values()].sort(
        (a, b) => b.similarity - a.similarity,
      );

      const mmrLambda =
        resolveMmr(options.mmr) ??
        resolveMmr(
          this.retrievalConfig.mmr
            ? { lambda: this.retrievalConfig.mmr.lambda }
            : undefined,
        );
      let rankingReason = "cosine similarity";
      if (mmrLambda !== null) {
        results = applyMmr(results, Math.max(topK * 2, topK), mmrLambda);
        rankingReason = `MMR(lambda=${mmrLambda})`;
      }

      if (options.rerank && this.reranker) {
        const reranked = await this.reranker.rerank(
          query,
          results.map((r) => ({ id: r.id, text: r.content.text })),
          topK,
        );
        const order = new Map(
          reranked.map((r, i) => [r.id, { score: r.score, i }]),
        );
        results = results
          .filter((r) => order.has(r.id))
          .sort((a, b) => order.get(a.id)!.i - order.get(b.id)!.i)
          .map((r) => ({
            ...r,
            similarity: order.get(r.id)?.score ?? r.similarity,
          }));
        rankingReason = `reranker:${(this.reranker as { name?: string }).name ?? "custom"}`;
      }

      const rankingTime = performance.now() - tRank;
      trace.mark("rankingMs", rankingTime);
      results = results.slice(0, topK);

      const tSer = performance.now();
      // Materialize final payload (serialization stage).
      const serialized = results.map((r) => ({ ...r }));
      trace.mark("serializationMs", performance.now() - tSer);

      const telemetryFields = {
        provider: storage.name,
        query,
        filters: options.filter ?? null,
        returnedCount: serialized.length,
        memoryIds: serialized.map((r) => r.id),
        similarityScores: serialized.map((r) => r.similarity),
        embeddingProvider: embedding.model,
        model: embedding.model,
        agentId:
          options.filter?.agent ??
          commonAgent(serialized.map((result) => result.agent)),
        tags: commonTags(serialized.map((result) => result.metadata)),
      };

      if (!explain) {
        if (options.includeGraph === true && this.graph) {
          const tGraph = performance.now();
          for (const hit of serialized) {
            hit.related = await this.hydrateRelated(hit.id);
          }
          trace.mark("databaseReadMs", performance.now() - tGraph);
        }
        trace.success(telemetryFields);
        return serialized;
      }

      const explanations: RecallExplanationHit[] = serialized.map((memory) => {
        const matchedFields: string[] = ["content"];
        if (options.filter?.agent) matchedFields.push("agent");
        if (options.filter?.metadata) matchedFields.push("metadata");
        return {
          memory,
          score: memory.similarity,
          distance: distances.get(memory.id) ?? 1 - memory.similarity,
          rankingReason,
          matchedFields,
          metadataMatch: metadataMatched.get(memory.id) ?? true,
          providerUsed: storage.name,
          searchTime,
          rankingTime,
        };
      });

      const totalTime = performance.now() - trace.startedAt;
      const persistedExplain: PersistedRecallExplainPayload = {
        enabled: true,
        providerUsed: storage.name,
        rankingStrategy: rankingReason,
        signals: {
          semantic: "enabled",
          keyword: keywordSignal,
          reranker:
            options.rerank === true && this.reranker ? "enabled" : "disabled",
          mmr: mmrLambda === null ? "disabled" : "enabled",
          recency: "disabled",
        },
        results: explanations.map((hit) => ({
          memoryId: hit.memory.id,
          score: hit.score,
          distance: hit.distance,
          rankingReason: hit.rankingReason,
          matchedFields: hit.matchedFields,
          metadataMatch: hit.metadataMatch,
        })),
        searchTimeMs: searchTime,
        rankingTimeMs: rankingTime,
        totalTimeMs: totalTime,
      };
      trace.success({ ...telemetryFields, explain: persistedExplain });

      return {
        results: explanations,
        providerUsed: storage.name,
        searchTime,
        rankingTime,
        totalTime,
        traceId: trace.context.traceId,
      };
    } catch (error) {
      trace.failure(error, {
        query: options.query,
        agentId: options.filter?.agent ?? null,
      });
      throw wrapOperationError("recall", error);
    }
  }

  /** Batch recall — parent event + child traces. */
  async recallBatch(
    queries: Array<Omit<RecallOptions, "explain">>,
  ): Promise<RecallResult[][]> {
    const parent = this.telemetry.start("recallBatch");
    try {
      if (!Array.isArray(queries) || queries.length === 0) {
        throw new ValidationError("recallBatch requires a non-empty array");
      }
      const out: RecallResult[][] = [];
      for (const q of queries) {
        const child = parent.child("recall");
        try {
          const hits = await this.recall({ ...q, explain: false });
          child.success({
            query: q.query,
            returnedCount: hits.length,
            memoryIds: hits.map((h) => h.id),
            similarityScores: hits.map((h) => h.similarity),
          });
          out.push(hits);
        } catch (error) {
          child.failure(error, { query: q.query });
          throw error;
        }
      }
      parent.success({
        returnedCount: out.reduce((n, r) => n + r.length, 0),
        extra: { queryCount: queries.length },
      });
      return out;
    } catch (error) {
      parent.failure(error);
      throw wrapOperationError("recallBatch", error);
    }
  }

  async compress(
    this: Wolbarg<true>,
    options: CompressOptions,
  ): Promise<CompressResult> {
    return this.runCompress(options);
  }

  /** @internal */
  private async runCompress(options: CompressOptions): Promise<CompressResult> {
    const trace = this.telemetry.start("compress");
    try {
      const { storage, embedding, organization } = await this.requireReady();
      if (!this.compression) {
        throw new ProviderNotConfiguredError(
          "llm",
          "compress",
          "pass llm: openaiLlm(...) (or compression) in the constructor",
        );
      }
      assertNonEmptyString(options.agent, "agent");
      const limit = options.limit ?? 50;
      assertFiniteNumber(limit, "limit", { min: 2, max: 500 });

      const tRead = performance.now();
      const rows = await storage.listMemories(
        {
          organization,
          agent: options.agent.trim(),
          includeArchived: false,
        },
        limit,
      );
      trace.mark("databaseReadMs", performance.now() - tRead);

      if (rows.length < 2) {
        throw new ValidationError(
          "compress requires at least 2 active memories for the given agent",
        );
      }

      const records = rows.map(toMemoryRecord);
      const summaryText = await this.compression.compress(records);
      const tEmbed = performance.now();
      const vector = await embedding.embed(summaryText);
      trace.mark("embeddingMs", performance.now() - tEmbed);
      this.assertEmbeddingDimensions(vector.length);

      const summaryId = createId();
      const timestamp = nowIso();

      const result = await this.withWriteLock(async () => {
        const tWrite = performance.now();
        const summaryRow = await storage.insertMemory({
          id: summaryId,
          organization,
          agent: options.agent.trim(),
          contentText: summaryText,
          metadata: {
            compressed: true,
            sourceCount: records.length,
            sourceIds: records.map((r) => r.id),
          },
          embedding: vector,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        const archivedIds = await storage.archiveMemories(
          records.map((r) => r.id),
          organization,
          summaryId,
          timestamp,
        );
        trace.mark("databaseWriteMs", performance.now() - tWrite);

        return {
          summary: toMemoryRecord(summaryRow),
          archivedIds,
        };
      });

      trace.success({
        provider: storage.name,
        memoryIds: [result.summary.id, ...result.archivedIds],
        returnedCount: 1,
        agentId: options.agent.trim(),
      });
      this.emitChange({
        event: "compress",
        organization,
        agent: options.agent.trim(),
        memoryId: [result.summary.id, ...result.archivedIds],
        timestamp,
        sessionId: this.telemetry.sessionId,
      });
      return result;
    } catch (error) {
      trace.failure(error, { agentId: options.agent });
      throw wrapOperationError("compress", error);
    }
  }

  async ingest(options: IngestOptions): Promise<IngestResult> {
    const trace = this.telemetry.start("ingest");
    try {
      const { storage, embedding, organization } = await this.requireReady();
      assertNonEmptyString(options.agent, "agent");

      const loaded = await loadIngestSource(options.source);
      let usedOcr = false;
      let usedVision = false;
      let text = loaded.rawText ?? "";

      if (!loaded.rawText) {
        const parser = resolveParser(loaded.filename, loaded.mimeType);
        const parsed = await parser.parse({
          buffer: loaded.buffer,
          filename: loaded.filename,
          mimeType: loaded.mimeType,
        });
        text = parsed.text;

        if (parsed.isImage && parsed.imageBuffer) {
          const parts: string[] = [];
          if (this.ocr) {
            const ocrResult = await this.ocr.recognize(
              parsed.imageBuffer,
              parsed.mimeType,
            );
            if (ocrResult.text) {
              parts.push(ocrResult.text);
              usedOcr = true;
            }
          }
          if (this.vision) {
            const visionResult = await this.vision.analyze(
              parsed.imageBuffer,
              parsed.mimeType,
            );
            if (visionResult.caption) {
              parts.push(`Caption: ${visionResult.caption}`);
            }
            if (visionResult.description) {
              parts.push(visionResult.description);
            }
            if (visionResult.entities.length > 0) {
              parts.push(`Entities: ${visionResult.entities.join(", ")}`);
            }
            if (parts.length > 0) {
              usedVision = true;
            }
          }
          text = parts.join("\n\n").trim();
        }
      }

      if (!text) {
        throw new ValidationError(
          "ingest could not extract text from the document (configure ocr/vision for images, or provide text)",
        );
      }

      const strategy =
        this.chunking ??
        (options.chunking?.strategy
          ? createChunkingStrategy(options.chunking.strategy)
          : inferChunkingStrategy(text));

      const chunks = strategy.chunk(text, {
        chunkSize: options.chunking?.chunkSize,
        overlap: options.chunking?.overlap,
      });

      if (chunks.length === 0) {
        throw new ValidationError("ingest produced zero chunks");
      }

      const tEmbed = performance.now();
      const vectors = await embedMany(
        embedding,
        chunks.map((c) => c.text),
      );
      trace.mark("embeddingMs", performance.now() - tEmbed);
      for (const vector of vectors) {
        this.assertEmbeddingDimensions(vector.length);
      }

      const baseMeta = options.metadata ?? {};
      const timestamp = nowIso();
      const inputs = chunks.map((chunk, i) => ({
        id: createId(),
        organization,
        agent: options.agent.trim(),
        contentText: chunk.text,
        metadata: {
          ...baseMeta,
          ingest: true,
          chunkIndex: chunk.index,
          chunkCount: chunks.length,
          sourceFilename: loaded.filename ?? null,
        },
        embedding: vectors[i]!,
        createdAt: timestamp,
        updatedAt: timestamp,
        contentHash: this.memoryDedupe.enabled
          ? hashMemoryContent(chunk.text)
          : null,
      }));

      let rows;
      if (this.memoryDedupe.enabled) {
        const memories: RememberResult[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const result = await this.rememberOne(
            {
              agent: options.agent.trim(),
              content: { text: chunks[i]!.text },
              metadata: {
                ...baseMeta,
                ingest: true,
                chunkIndex: chunks[i]!.index,
                chunkCount: chunks.length,
                sourceFilename: loaded.filename ?? null,
              },
            },
            trace,
          );
          memories.push(result);
        }
        const result = {
          memories,
          extractedChars: text.length,
          chunkCount: chunks.length,
          usedOcr,
          usedVision,
        };
        trace.success({
          provider: storage.name,
          memoryIds: result.memories.map((m) => m.id),
          returnedCount: result.memories.length,
          agentId: options.agent.trim(),
          tags: telemetryTags(baseMeta),
        });
        this.emitChange({
          event: "ingest",
          organization,
          agent: options.agent.trim(),
          memoryId: result.memories.map((m) => m.id),
          timestamp,
          sessionId: this.telemetry.sessionId,
        });
        return result;
      }

      rows = await this.withWriteLock(async () => {
        const tWrite = performance.now();
        const result = await storage.insertMemoriesBatch(inputs);
        trace.mark("databaseWriteMs", performance.now() - tWrite);
        return result;
      });

      const result = {
        memories: rows.map(toMemoryRecord),
        extractedChars: text.length,
        chunkCount: chunks.length,
        usedOcr,
        usedVision,
      };
      trace.success({
        provider: storage.name,
        memoryIds: result.memories.map((m) => m.id),
        returnedCount: result.memories.length,
        agentId: options.agent.trim(),
        tags: telemetryTags(baseMeta),
      });
      this.emitChange({
        event: "ingest",
        organization,
        agent: options.agent.trim(),
        memoryId: result.memories.map((m) => m.id),
        timestamp,
        sessionId: this.telemetry.sessionId,
      });
      return result;
    } catch (error) {
      trace.failure(error, { agentId: options.agent });
      throw wrapOperationError("ingest", error);
    }
  }

  /**
   * Link two memories in the optional graph layer.
   * Throws {@link ProviderNotConfiguredError} when no graph provider is set.
   */
  async linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const trace = this.telemetry.start("linkMemories");
    try {
      await this.requireReady();
      const graph = this.requireGraph("linkMemories");
      assertNonEmptyString(fromId, "fromId");
      assertNonEmptyString(toId, "toId");
      assertNonEmptyString(relation, "relation");
      const tGraph = performance.now();
      await graph.linkMemories(
        fromId.trim(),
        toId.trim(),
        relation.trim(),
        metadata,
      );
      trace.mark("databaseWriteMs", performance.now() - tGraph);
      trace.success({
        provider: graph.name,
        memoryIds: [fromId.trim(), toId.trim()],
        extra: { relation: relation.trim() },
      });
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("linkMemories", error);
    }
  }

  /**
   * Traverse related memories via the optional graph layer.
   * Throws {@link ProviderNotConfiguredError} when no graph provider is set.
   * Results are re-hydrated from SQL storage when available.
   */
  async getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]> {
    const trace = this.telemetry.start("getRelated");
    try {
      await this.requireReady();
      const graph = this.requireGraph("getRelated");
      assertNonEmptyString(memoryId, "memoryId");
      const tGraph = performance.now();
      const related = await this.hydrateRelated(memoryId.trim(), options);
      trace.mark("databaseReadMs", performance.now() - tGraph);
      trace.success({
        provider: graph.name,
        memoryIds: [memoryId.trim(), ...related.map((r) => r.id)],
        returnedCount: related.length,
      });
      return related;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("getRelated", error);
    }
  }

  async forget(options: ForgetOptions): Promise<number> {
    const trace = this.telemetry.start("forget");
    try {
      const { storage, organization } = await this.requireReady();

      const deletedIds: string[] = [];
      const deleted = await this.withWriteLock(async () => {
        if ("id" in options && options.id !== undefined) {
          assertNonEmptyString(options.id, "id");
          const id = options.id.trim();
          const ok = await storage.deleteMemoryById(id, organization);
          if (ok) deletedIds.push(id);
          return ok ? 1 : 0;
        }

        if ("filter" in options && options.filter?.agent) {
          assertNonEmptyString(options.filter.agent, "filter.agent");
          const rows = await storage.listMemories({
            organization,
            agent: options.filter.agent.trim(),
            includeArchived: true,
          });
          for (const row of rows) deletedIds.push(row.id);
          return storage.deleteMemoriesByFilter({
            organization,
            agent: options.filter.agent.trim(),
            includeArchived: true,
          });
        }

        throw new ValidationError(
          "forget requires either { id } or { filter: { agent } }",
        );
      });

      if (deleted > 0 && this.graph && deletedIds.length > 0) {
        const tGraph = performance.now();
        for (const id of deletedIds) {
          await this.graph.deleteMemory(id);
        }
        trace.mark("databaseWriteMs", performance.now() - tGraph);
      }

      trace.success({
        provider: storage.name,
        returnedCount: deleted,
        memoryIds: deletedIds.length > 0 ? deletedIds : null,
        filters: "filter" in options ? options.filter : null,
        agentId:
          "filter" in options ? options.filter?.agent?.trim() ?? null : null,
        extra: this.graph
          ? { graphCascade: deletedIds.length }
          : undefined,
      });
      if (deleted > 0) {
        this.emitChange({
          event: "forget",
          organization,
          agent:
            ("filter" in options && options.filter?.agent?.trim()) ||
            ("id" in options ? "*" : "*"),
          memoryId:
            "id" in options && options.id ? options.id.trim() : [],
          timestamp: nowIso(),
          sessionId: this.telemetry.sessionId,
        });
      }
      return deleted;
    } catch (error) {
      trace.failure(error, {
        agentId: "filter" in options ? options.filter?.agent ?? null : null,
      });
      throw wrapOperationError("forget", error);
    }
  }

  async history(options: HistoryOptions): Promise<HistoryResult> {
    const trace = this.telemetry.start("history");
    try {
      const { storage, organization } = await this.requireReady();
      assertNonEmptyString(options.id, "id");

      const row = await storage.getMemoryById(options.id.trim(), organization);
      if (!row) {
        throw new MemoryNotFoundError(`Memory not found: ${options.id}`);
      }

      const events = await storage.getHistory(row.id);
      const result = {
        memory: toMemoryRecord(row),
        events: events.map(toHistoryEvent),
      };
      trace.success({
        provider: storage.name,
        memoryIds: [row.id],
        returnedCount: events.length,
        agentId: row.agent,
        tags: telemetryTags(deserializeMetadata(row.metadata_json)),
      });
      return result;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("history", error);
    }
  }

  async stats(): Promise<StatsResult> {
    const trace = this.telemetry.start("stats");
    try {
      const { storage, embedding, organization } = await this.requireReady();
      const counts = await storage.getStats(organization);
      const databaseSizeBytes = await storage.getDatabaseSizeBytes();

      const result = {
        totalMemories: counts.totalMemories,
        activeMemories: counts.activeMemories,
        archivedMemories: counts.archivedMemories,
        totalAgents: counts.totalAgents,
        databaseSizeBytes,
        embeddingModel: embedding.model,
        llmModel: this.llm?.model ?? null,
        organization,
        embeddingDimensions: this.embeddingDimensions ?? 0,
      };
      trace.success({
        provider: storage.name,
        returnedCount: result.totalMemories,
      });
      return result;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("stats", error);
    }
  }

  async clear(options: ClearOptions): Promise<number> {
    const trace = this.telemetry.start("clear");
    try {
      const { storage, organization } = await this.requireReady();

      if (!options || options.confirm !== true) {
        throw new ValidationError(
          "clear requires { confirm: true } to permanently delete all memories",
        );
      }

      const deleted = await this.withWriteLock(async () => {
        if (this.graph) {
          const rows = await storage.listMemories({
            organization,
            includeArchived: true,
          });
          for (const row of rows) {
            await this.graph.deleteMemory(row.id);
          }
        }
        return storage.clearOrganization(organization);
      });
      trace.success({ provider: storage.name, returnedCount: deleted });
      return deleted;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("clear", error);
    }
  }

  /** Create an immutable named checkpoint of the memory database. */
  async checkpoint(
    name: string,
    options?: CheckpointOptions,
  ): Promise<CheckpointInfo> {
    const trace = this.telemetry.start("checkpoint");
    try {
      await this.requireReady();
      const provider = this.requireCheckpointProvider();
      const source = this.requireMemoryDbPath();
      this.assertGraphCheckpointSupported("checkpoint");
      const tCheckpoint = performance.now();
      const meta = await provider.checkpoint(name, source, options);
      await this.snapshotGraphAlongside(meta.snapshotPath, "checkpoint");
      trace.mark("databaseWriteMs", performance.now() - tCheckpoint);
      trace.success({
        provider: provider.name,
        checkpointId: meta.name,
        extra: { checkpoint: meta.name },
      });
      return meta;
    } catch (error) {
      trace.failure(error, { checkpointId: name });
      throw wrapOperationError("checkpoint", error);
    }
  }

  /** Restore the memory database from a named checkpoint. */
  async rollback(name: string): Promise<CheckpointInfo> {
    const trace = this.telemetry.start("rollback");
    let storageClosed = false;
    try {
      await this.requireReady();
      const provider = this.requireCheckpointProvider();
      const target = this.requireMemoryDbPath();

      // Validate before closing — a missing checkpoint must not leave storage shut.
      const existing = await provider.getCheckpoint(name);
      if (!existing) {
        throw new ValidationError(`Checkpoint "${name}" was not found`);
      }

      // Close storage before replacing the file.
      if (this.storage) {
        await this.storage.close();
        storageClosed = true;
      }
      const graphClosed = await this.closeGraphForSnapshot();
      const tRollback = performance.now();
      const meta = await provider.rollback(name, target);
      await this.restoreGraphAlongside(meta.snapshotPath, "rollback");
      if (graphClosed) {
        await this.graph?.open();
      }
      trace.mark("databaseWriteMs", performance.now() - tRollback);
      await this.storage?.open();
      storageClosed = false;
      if (this.embeddingDimensions !== null) {
        await this.storage?.ensureVectorSchema(this.embeddingDimensions);
      }

      trace.success({
        provider: provider.name,
        checkpointId: meta.name,
        extra: { checkpoint: meta.name },
      });
      return meta;
    } catch (error) {
      if (storageClosed && this.storage) {
        await this.storage.open().catch(() => undefined);
        if (this.embeddingDimensions !== null) {
          await this.storage
            .ensureVectorSchema(this.embeddingDimensions)
            .catch(() => undefined);
        }
      }
      trace.failure(error, { checkpointId: name });
      throw wrapOperationError("rollback", error);
    }
  }

  async deleteCheckpoint(name: string): Promise<boolean> {
    const trace = this.telemetry.start("deleteCheckpoint");
    try {
      await this.requireReady();
      const provider = this.requireCheckpointProvider();
      const tDelete = performance.now();
      const removed = await provider.deleteCheckpoint(name);
      trace.mark("databaseWriteMs", performance.now() - tDelete);
      trace.success({
        provider: provider.name,
        checkpointId: name,
        returnedCount: removed ? 1 : 0,
      });
      return removed;
    } catch (error) {
      trace.failure(error, { checkpointId: name });
      throw wrapOperationError("deleteCheckpoint", error);
    }
  }

  async listCheckpoints(): Promise<CheckpointInfo[]> {
    const trace = this.telemetry.start("listCheckpoints");
    try {
      await this.requireReady();
      const provider = this.requireCheckpointProvider();
      const tList = performance.now();
      const list = await provider.listCheckpoints();
      trace.mark("databaseReadMs", performance.now() - tList);
      trace.success({
        provider: provider.name,
        returnedCount: list.length,
      });
      return list;
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("listCheckpoints", error);
    }
  }

  async getCheckpoint(name: string): Promise<CheckpointInfo | null> {
    const trace = this.telemetry.start("getCheckpoint");
    try {
      await this.requireReady();
      const provider = this.requireCheckpointProvider();
      const tGet = performance.now();
      const meta = await provider.getCheckpoint(name);
      trace.mark("databaseReadMs", performance.now() - tGet);
      trace.success({
        provider: provider.name,
        checkpointId: name,
        returnedCount: meta ? 1 : 0,
      });
      return meta;
    } catch (error) {
      trace.failure(error, { checkpointId: name });
      throw wrapOperationError("getCheckpoint", error);
    }
  }

  /** Export the memory database to a portable SQLite + manifest bundle. */
  async export(exportPath: string): Promise<ExportResult> {
    const trace = this.telemetry.start("export");
    try {
      await this.requireReady();
      const source = this.requireMemoryDbPath();
      this.assertGraphCheckpointSupported("export");
      // Checkpoint WAL so export sees a consistent file.
      if (this.storage?.name === "sqlite") {
        // best-effort consistency via transfer helper
      }
      const result: MemoryExportResult = await this.transfer.exportTo(
        exportPath,
        source,
        this.organization ?? undefined,
      );
      await this.snapshotGraphAlongside(result.path, "export");
      trace.success({
        provider: "sqlite",
        extra: { path: result.path, sizeBytes: result.sizeBytes },
      });
      return {
        path: result.path,
        sizeBytes: result.sizeBytes,
        exportedAt: result.manifest.exportedAt,
      };
    } catch (error) {
      trace.failure(error);
      throw wrapOperationError("export", error);
    }
  }

  /** Import a previously exported memory database, replacing the current file. */
  async import(exportPath: string): Promise<ImportResult> {
    const trace = this.telemetry.start("import");
    let storageClosed = false;
    try {
      await this.requireReady();
      const target = this.requireMemoryDbPath();
      if (this.storage) {
        await this.storage.close();
        storageClosed = true;
      }
      const graphClosed = await this.closeGraphForSnapshot();
      this.assertGraphCheckpointSupported("import");
      const result: MemoryImportResult = await this.transfer.importFrom(
        exportPath,
        target,
      );
      await this.restoreGraphAlongside(result.path, "import");
      if (graphClosed) {
        await this.graph?.open();
      }
      await this.storage?.open();
      storageClosed = false;
      if (this.embeddingDimensions !== null) {
        await this.storage?.ensureVectorSchema(this.embeddingDimensions);
      }
      trace.success({
        provider: "sqlite",
        extra: { path: result.path },
      });
      return {
        path: result.path,
        importedAt: nowIso(),
      };
    } catch (error) {
      if (storageClosed && this.storage) {
        await this.storage.open().catch(() => undefined);
        if (this.embeddingDimensions !== null) {
          await this.storage
            .ensureVectorSchema(this.embeddingDimensions)
            .catch(() => undefined);
        }
      }
      trace.failure(error);
      throw wrapOperationError("import", error);
    }
  }

  /** Flush pending telemetry (useful in tests). */
  async flushTelemetry(): Promise<void> {
    await this.telemetry.flush();
  }

  /** Session id for this SDK instance (telemetry traces). */
  get sessionId(): string {
    return this.telemetry.sessionId;
  }

  /**
   * Optional process-wide lock for SQLite read-modify-write (dedupe upsert).
   * Plain inserts must NOT take this lock — the provider coalesces concurrent
   * insertMemory calls under a single BEGIN IMMEDIATE for multi-writer throughput.
   */
  private withWriteLock<T>(
    fn: () => Promise<T>,
    options?: { exclusive?: boolean },
  ): Promise<T> {
    if (
      options?.exclusive &&
      this.storage?.name === "sqlite"
    ) {
      return this.writeMutex.runExclusive(fn);
    }
    return fn();
  }

  async close(): Promise<void> {
    if (this.storage) {
      this.telemetry.emitShutdown(this.storage.name);
    }
    await this.subscribeBackend?.close().catch(() => undefined);
    await this.pgListenBackend?.close().catch(() => undefined);
    this.subscribeBackend = null;
    this.pgListenBackend = null;
    await this.telemetry.close().catch(() => undefined);
    await this.checkpointProvider?.close().catch(() => undefined);
    await this.graph?.close().catch(() => undefined);
    this.graph = null;
    if (this.storage) {
      await this.storage.close();
    }
    this.storage = null;
    this.embedding = null;
    this.rawEmbedding = null;
    this.llm = null;
    this.compression = null;
    this.organization = null;
    this.embeddingDimensions = null;
    this.initialized = false;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  private async requireReady(): Promise<ReadyState> {
    await this.ready();
    if (
      !this.initialized ||
      !this.storage ||
      !this.embedding ||
      !this.organization
    ) {
      throw new InitializationError(
        "Wolbarg is not initialized. Pass options to the constructor or call init().",
      );
    }
    return {
      storage: this.storage,
      embedding: this.embedding,
      organization: this.organization,
    };
  }

  private assertEmbeddingDimensions(dimensions: number): void {
    if (
      this.embeddingDimensions !== null &&
      dimensions !== this.embeddingDimensions
    ) {
      throw new ValidationError(
        `Embedding dimension mismatch: expected ${this.embeddingDimensions}, got ${dimensions}`,
      );
    }
  }

  private requireCheckpointProvider(): CheckpointProvider {
    if (!this.checkpointProvider) {
      throw new ProviderNotConfiguredError(
        "checkpoint",
        "checkpoint",
        "construct Wolbarg with a file-backed database",
      );
    }
    return this.checkpointProvider;
  }

  private requireGraph(method: string): GraphProvider {
    if (!this.graph) {
      throw new ProviderNotConfiguredError(
        "graph",
        method,
        "pass graph: sqliteGraph({ path }) or graph: neo4jGraph({ url, username, password })",
      );
    }
    return this.graph;
  }

  private assertGraphCheckpointSupported(operation: string): void {
    if (!this.graph) return;
    if (!this.graph.supportsFileSnapshot()) {
      throw new GraphCheckpointNotSupportedError(this.graph.name, operation);
    }
  }

  private graphSnapshotDir(alongsidePath: string): string {
    return `${alongsidePath}.graph`;
  }

  private async closeGraphForSnapshot(): Promise<boolean> {
    if (!this.graph || !this.graph.supportsFileSnapshot()) return false;
    await this.graph.close();
    return true;
  }

  private async snapshotGraphAlongside(
    alongsidePath: string,
    operation: string,
  ): Promise<void> {
    if (!this.graph) return;
    if (!this.graph.supportsFileSnapshot()) {
      throw new GraphCheckpointNotSupportedError(this.graph.name, operation);
    }
    const dataPath = this.graph.getDataPath();
    if (!dataPath) return;
    const dest = this.graphSnapshotDir(alongsidePath);
    // Close briefly so files are consistent on Windows.
    await this.graph.close();
    try {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      if (fs.existsSync(dataPath)) {
        const stat = fs.statSync(dataPath);
        if (stat.isDirectory()) {
          fs.cpSync(dataPath, dest, { recursive: true });
        } else {
          fs.mkdirSync(dest, { recursive: true });
          fs.cpSync(dataPath, path.join(dest, path.basename(dataPath)));
          // Copy sibling WAL/SHM files if present (SQLite graph file).
          const parent = path.dirname(dataPath);
          const base = path.basename(dataPath);
          for (const entry of fs.readdirSync(parent)) {
            if (entry === base) continue;
            if (entry.startsWith(base)) {
              fs.cpSync(
                path.join(parent, entry),
                path.join(dest, entry),
                { recursive: true },
              );
            }
          }
        }
      }
    } finally {
      await this.graph.open();
    }
  }

  private async restoreGraphAlongside(
    alongsidePath: string,
    operation: string,
  ): Promise<void> {
    if (!this.graph) return;
    if (!this.graph.supportsFileSnapshot()) {
      throw new GraphCheckpointNotSupportedError(this.graph.name, operation);
    }
    const dataPath = this.graph.getDataPath();
    if (!dataPath) return;
    const src = this.graphSnapshotDir(alongsidePath);
    if (!fs.existsSync(src)) {
      // Older checkpoints without graph snapshot — leave graph empty/as-is.
      return;
    }
    if (fs.existsSync(dataPath)) {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
    const entries = fs.readdirSync(src);
    if (entries.length === 1 && entries[0] === path.basename(dataPath)) {
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      fs.cpSync(path.join(src, entries[0]!), dataPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      fs.cpSync(src, dataPath, { recursive: true });
    }
  }

  private async hydrateRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]> {
    const graph = this.requireGraph("getRelated");
    const related = await graph.getRelated(memoryId, options);
    const { storage, organization } = await this.requireReady();
    const out: MemoryRecord[] = [];
    for (const stub of related) {
      const row = await storage.getMemoryById(stub.id, organization);
      if (row) {
        out.push(toMemoryRecord(row));
      } else {
        out.push(stub);
      }
    }
    return out;
  }

  private requireMemoryDbPath(): string {
    if (!this.memoryDbPath || this.memoryDbPath === ":memory:") {
      throw new ConfigurationError(
        "This operation requires a file-backed SQLite memory database (not :memory:).",
        {
          suggestion:
            'Use database: { provider: "sqlite", url: "./memory.db" }',
        },
      );
    }
    return path.isAbsolute(this.memoryDbPath)
      ? this.memoryDbPath
      : path.resolve(process.cwd(), this.memoryDbPath);
  }
}

/** Preferred v0.3 entry — re-exported from factories as well. */
export function wolbarg(options: WolbargOptions): Wolbarg {
  return new Wolbarg(options as never);
}

function telemetryTags(metadata: Record<string, unknown>): string[] | null {
  const value = metadata.tags;
  if (typeof value === "string") {
    const tag = value.trim();
    return tag ? [tag] : null;
  }
  if (Array.isArray(value)) {
    const tags = value.filter(
      (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
    );
    return tags.length > 0 ? tags.map((tag) => tag.trim()) : null;
  }
  return null;
}

function commonAgent(agents: string[]): string | null {
  const first = agents[0];
  return first && agents.every((agent) => agent === first) ? first : null;
}

function commonTags(metadata: Array<Record<string, unknown>>): string[] | null {
  const tags = new Set<string>();
  for (const item of metadata) {
    for (const tag of telemetryTags(item) ?? []) tags.add(tag);
  }
  return tags.size > 0 ? [...tags] : null;
}
