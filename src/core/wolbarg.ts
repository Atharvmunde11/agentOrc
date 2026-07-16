/**
 * Wolbarg — modular semantic memory SDK for AI agents (v0.2).
 *
 * @example
 * ```ts
 * import { Wolbarg, sqlite, openaiEmbedding, openaiLlm } from "wolbarg";
 *
 * const ctx = new Wolbarg({
 *   organization: "my-org",
 *   storage: sqlite("./memory.db"),
 *   embedding: openaiEmbedding({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "text-embedding-3-small",
 *   }),
 *   llm: openaiLlm({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "gpt-4.1-mini",
 *   }),
 * });
 *
 * await ctx.ready();
 * await ctx.remember({ agent: "research", content: { text: "…" } });
 * const hits = await ctx.recall({ query: "…", topK: 5 });
 * ```
 */

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
import { createLlmProvider, type LlmProvider } from "../llm/index.js";
import {
  loadIngestSource,
  resolveParser,
} from "../ingest/index.js";
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
  adaptiveFetchK,
  applyMmr,
  fuseScores,
  resolveHybridWeights,
  resolveMmr,
} from "../retrieval/index.js";
import {
  ConfigurationError,
  InitializationError,
  MemoryNotFoundError,
  ProviderNotConfiguredError,
  ValidationError,
} from "../errors/index.js";
import type {
  ClearOptions,
  CompressOptions,
  CompressResult,
  ForgetOptions,
  HistoryOptions,
  HistoryResult,
  IngestOptions,
  IngestResult,
  InitOptions,
  MemoryRecord,
  RecallOptions,
  RecallResult,
  RememberOptions,
  RetrievalConfig,
  StatsResult,
} from "../types/index.js";
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
} from "./options.js";
import { validateWolbargOptions, validateInitOptions } from "./validate.js";

type ReadyState = {
  storage: StorageProvider;
  embedding: EmbeddingProvider;
  organization: string;
};

export class Wolbarg<HasLlm extends boolean = false> {
  /** Compile-time capability flag — `true` when constructed with `llm`. */
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
  private chunking: ChunkingStrategy | null = null;
  private retrievalConfig: RetrievalConfig = {};
  private embeddingDimensions: number | null = null;
  private readonly writeMutex = new AsyncMutex();

  /**
   * Create an Wolbarg instance.
   * When options are provided, providers are wired immediately and
   * storage opens lazily on the first API call (or {@link ready}).
   *
   * Pass `llm` to enable {@link compress} (typed at compile time).
   */
  constructor(options: WolbargOptionsWithLlm);
  constructor(options: WolbargOptionsWithoutLlm);
  constructor();
  constructor(options?: WolbargOptions) {
    if (!options) {
      return;
    }

    const validated = validateWolbargOptions(options);
    this.organization = validated.organization;
    this.storage = isStorageProvider(validated.storage)
      ? validated.storage
      : createStorageProvider(validated.storage);
    this.embedding = isEmbeddingProvider(validated.embedding)
      ? validated.embedding
      : createEmbeddingProvider(validated.embedding);

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
    this.chunking = validated.chunking ?? null;
    this.retrievalConfig = validated.retrieval ?? {};
  }

  /**
   * Backwards-compatible initialization (v0.1 API).
   * Prefer the constructor with `storage` / `embedding` / optional `llm`.
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
    this.embedding = createEmbeddingProvider(validated.embedding);
    if (validated.llm) {
      this.llm = createLlmProvider(validated.llm);
      this.compression = createCompressionProvider(this.llm);
    }

    await this.ready();
  }

  /** Ensure storage is open and embedding dimensions are known. */
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
      const probe = await this.embedding.validate();
      await this.storage.ensureVectorSchema(probe.dimensions);
      this.embeddingDimensions = probe.dimensions;
      this.initialized = true;
    } catch (error) {
      await this.storage.close().catch(() => undefined);
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

  /** Store a semantic memory for an agent. */
  async remember(options: RememberOptions): Promise<MemoryRecord> {
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

    const profile = process.env.WOLBARG_PROFILE === "1";
    const t0 = profile ? performance.now() : 0;
    const vector = await embedding.embed(options.content.text);
    const embedMs = profile ? performance.now() - t0 : 0;
    this.assertEmbeddingDimensions(vector.length);

    const id = createId();
    const timestamp = nowIso();

    return this.withWriteLock(async () => {
      const tStore = profile ? performance.now() : 0;
      const row = await storage.insertMemory({
        id,
        organization,
        agent: options.agent.trim(),
        contentText: options.content.text,
        metadata,
        embedding: vector,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (profile) {
        const storeMs = performance.now() - tStore;
        const totalMs = performance.now() - t0;
        console.log(
          `[profile] remember embed=${embedMs.toFixed(2)}ms store=${storeMs.toFixed(2)}ms total=${totalMs.toFixed(2)}ms backend=${storage.name}`,
        );
      }
      return toMemoryRecord(row);
    });
  }

  /**
   * Semantic / hybrid search over stored memories.
   * Optional keyword, metadata, MMR, and rerank stages degrade gracefully.
   */
  async recall(options: RecallOptions): Promise<RecallResult[]> {
    const { storage, embedding, organization } = await this.requireReady();
    assertNonEmptyString(options.query, "query");

    const topK = options.topK ?? 5;
    const threshold = options.threshold ?? 0;
    assertFiniteNumber(topK, "topK", { min: 1, max: 1000 });
    assertFiniteNumber(threshold, "threshold", { min: 0, max: 1 });

    const query = options.query.trim();
    const vector = await embedding.embed(query);
    this.assertEmbeddingDimensions(vector.length);

    const hasFilters = Boolean(
      options.filter?.agent || options.filter?.metadata,
    );
    const overFetch =
      this.retrievalConfig.overFetchFactor ?? (hasFilters ? 4 : 2);
    const fetchK = adaptiveFetchK(topK, overFetch, hasFilters);

    const semanticScores = new Map<string, number>();
    const byId = new Map<string, RecallResult>();

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
      for (const { row, distance } of joinedHits) {
        if (
          options.filter?.metadata &&
          !matchesMetadata(
            deserializeMetadata(row.metadata_json),
            options.filter.metadata,
          )
        ) {
          continue;
        }
        const similarity = distanceToSimilarity(distance);
        if (similarity < threshold) {
          continue;
        }
        const result = toRecallResult(row, similarity);
        semanticScores.set(result.id, similarity);
        byId.set(result.id, result);
      }
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

      for (const hit of hits) {
        const row = rowMap.get(hit.memoryRowid);
        if (!row) {
          continue;
        }
        if (options.filter?.agent && row.agent !== options.filter.agent) {
          continue;
        }
        if (!options.filter?.includeArchived && row.archived === 1) {
          continue;
        }
        const metadata = deserializeMetadata(row.metadata_json);
        if (
          options.filter?.metadata &&
          !matchesMetadata(metadata, options.filter.metadata)
        ) {
          continue;
        }

        const similarity = distanceToSimilarity(hit.distance);
        if (similarity < threshold) {
          continue;
        }

        const result = toRecallResult(row, similarity);
        semanticScores.set(result.id, similarity);
        byId.set(result.id, result);
      }
    }

    const hybridWeights =
      resolveHybridWeights(options.hybrid) ??
      (options.hybrid === undefined
        ? resolveHybridWeights(this.retrievalConfig.hybrid)
        : null);

    if (hybridWeights) {
      let keywordScores = new Map<string, number>();

      if (typeof storage.searchKeyword === "function") {
        const ftsHits = await storage.searchKeyword(
          query,
          organization,
          fetchK,
        );
        keywordScores = new Map(
          ftsHits.map((h) => [h.memoryId, h.score]),
        );
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
          }
        }
      } else if (this.keywordSearch) {
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
          if (byId.has(row.id)) {
            continue;
          }
          if (!keywordScores.has(row.id)) {
            continue;
          }
          const metadata = deserializeMetadata(row.metadata_json);
          if (
            options.filter?.metadata &&
            !matchesMetadata(metadata, options.filter.metadata)
          ) {
            continue;
          }
          if (!options.filter?.includeArchived && row.archived === 1) {
            continue;
          }
          byId.set(row.id, toRecallResult(row, 0));
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
    if (mmrLambda !== null) {
      results = applyMmr(results, Math.max(topK * 2, topK), mmrLambda);
    }

    if (options.rerank && this.reranker) {
      const reranked = await this.reranker.rerank(
        query,
        results.map((r) => ({ id: r.id, text: r.content.text })),
        topK,
      );
      const order = new Map(reranked.map((r, i) => [r.id, { score: r.score, i }]));
      results = results
        .filter((r) => order.has(r.id))
        .sort((a, b) => (order.get(a.id)!.i) - (order.get(b.id)!.i))
        .map((r) => ({
          ...r,
          similarity: order.get(r.id)?.score ?? r.similarity,
        }));
    }

    return results.slice(0, topK);
  }

  /**
   * Compress related memories for an agent into a single summarized memory.
   * Only available when `llm` (or `compression`) was configured at construction.
   */
  async compress(
    this: Wolbarg<true>,
    options: CompressOptions,
  ): Promise<CompressResult> {
    return this.runCompress(options);
  }

  /** @internal */
  private async runCompress(options: CompressOptions): Promise<CompressResult> {
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

    const rows = await storage.listMemories(
      {
        organization,
        agent: options.agent.trim(),
        includeArchived: false,
      },
      limit,
    );

    if (rows.length < 2) {
      throw new ValidationError(
        "compress requires at least 2 active memories for the given agent",
      );
    }

    const records = rows.map(toMemoryRecord);
    const summaryText = await this.compression.compress(records);
    const vector = await embedding.embed(summaryText);
    this.assertEmbeddingDimensions(vector.length);

    const summaryId = createId();
    const timestamp = nowIso();

    return this.withWriteLock(async () => {
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

      return {
        summary: toMemoryRecord(summaryRow),
        archivedIds,
      };
    });
  }

  /** Ingest a document: parse → OCR/vision (optional) → chunk → embed → store. */
  async ingest(options: IngestOptions): Promise<IngestResult> {
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

    const vectors = await embedMany(
      embedding,
      chunks.map((c) => c.text),
    );
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
    }));

    const rows = await this.withWriteLock(async () => {
      return storage.insertMemoriesBatch(inputs);
    });

    return {
      memories: rows.map(toMemoryRecord),
      extractedChars: text.length,
      chunkCount: chunks.length,
      usedOcr,
      usedVision,
    };
  }

  /** Delete memories by ID or filter. */
  async forget(options: ForgetOptions): Promise<number> {
    const { storage, organization } = await this.requireReady();

    return this.withWriteLock(async () => {
      if ("id" in options && options.id !== undefined) {
        assertNonEmptyString(options.id, "id");
        const deleted = await storage.deleteMemoryById(
          options.id.trim(),
          organization,
        );
        return deleted ? 1 : 0;
      }

      if ("filter" in options && options.filter?.agent) {
        assertNonEmptyString(options.filter.agent, "filter.agent");
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
  }

  /** Return the history of a memory. */
  async history(options: HistoryOptions): Promise<HistoryResult> {
    const { storage, organization } = await this.requireReady();
    assertNonEmptyString(options.id, "id");

    const row = await storage.getMemoryById(options.id.trim(), organization);
    if (!row) {
      throw new MemoryNotFoundError(`Memory not found: ${options.id}`);
    }

    const events = await storage.getHistory(row.id);
    return {
      memory: toMemoryRecord(row),
      events: events.map(toHistoryEvent),
    };
  }

  /** Aggregate statistics for the current organization. */
  async stats(): Promise<StatsResult> {
    const { storage, embedding, organization } = await this.requireReady();
    const counts = await storage.getStats(organization);
    const databaseSizeBytes = await storage.getDatabaseSizeBytes();

    return {
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
  }

  /** Delete every memory in the current organization. */
  async clear(options: ClearOptions): Promise<number> {
    const { storage, organization } = await this.requireReady();

    if (!options || options.confirm !== true) {
      throw new ValidationError(
        "clear requires { confirm: true } to permanently delete all memories",
      );
    }

    return this.withWriteLock(async () => {
      return storage.clearOrganization(organization);
    });
  }

  /**
   * Serialize writes for SQLite (single connection). Postgres uses a pool and
   * per-statement atomic CTEs — locking here only serializes throughput.
   */
  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.storage?.name === "sqlite") {
      return this.writeMutex.runExclusive(fn);
    }
    return fn();
  }

  /** Close the database connection and release resources. */
  async close(): Promise<void> {
    if (this.storage) {
      await this.storage.close();
    }
    this.storage = null;
    this.embedding = null;
    this.llm = null;
    this.compression = null;
    this.organization = null;
    this.embeddingDimensions = null;
    this.initialized = false;
  }

  /** Whether providers are ready for API calls. */
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
}
