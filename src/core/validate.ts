/**
 * Configuration validation for SDK initialization and constructor options.
 *
 * All validators throw {@link ConfigurationError} or {@link ValidationError}
 * with field-scoped messages suitable for IDE hover documentation.
 */

import type {
  WolbargOptions,
  StorageInput,
  GraphInput,
} from "./options.js";
import {
  isEmbeddingProvider,
  isGraphProvider,
  isLlmProvider,
  isStorageProvider,
  isTelemetryProvider,
  resolveDatabaseUrl,
} from "./options.js";
import type {
  DatabaseConfig,
  EmbeddingConfig,
  EmbeddingCacheConfig,
  InitOptions,
  LlmConfig,
  MemoryDedupeConfig,
  StorageConfig,
  TelemetryConfig,
  RetrievalConfig,
} from "../types/index.js";
import { ConfigurationError } from "../errors/index.js";
import { SqliteGraphProvider } from "../graph/providers/sqlite-graph.js";
import { Neo4jGraphProvider } from "../graph/providers/neo4j.js";
import type { GraphConfig, GraphProvider } from "../graph/types.js";

function assertNonEmpty(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${fieldName} must be a non-empty string`);
  }
}

function assertFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigurationError(`${fieldName} must be a finite number`);
  }
}

function assertNumberMin(value: number, fieldName: string, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigurationError(`${fieldName} must be >= ${min}`);
  }
}

function assertNumberInRange(
  value: number,
  fieldName: string,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(`${fieldName} must be between ${min} and ${max}`);
  }
}

function assertUrl(value: string, fieldName: string): void {
  assertNonEmpty(value, fieldName);
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new ConfigurationError(
      `${fieldName} must be a valid absolute URL (got "${value}")`,
    );
  }
}

/**
 * Validate and normalize embedding provider configuration.
 *
 * @param config - Raw embedding config from `wolbarg({ embedding })`.
 * @returns Trimmed, normalized config with trailing slashes removed from `baseUrl`.
 * @throws {@link ConfigurationError} when required fields are missing or invalid.
 */
export function validateEmbeddingConfig(config: EmbeddingConfig): EmbeddingConfig {
  assertUrl(config.baseUrl, "embedding.baseUrl");
  assertNonEmpty(config.apiKey, "embedding.apiKey");
  assertNonEmpty(config.model, "embedding.model");
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new ConfigurationError("embedding.timeoutMs must be a positive number");
  }
  return {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: config.apiKey,
    model: config.model.trim(),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

/**
 * Validate and normalize LLM provider configuration.
 *
 * @param config - Raw LLM config from `wolbarg({ llm })`.
 * @returns Normalized config with validated temperature and token limits.
 * @throws {@link ConfigurationError} when URLs, models, or numeric ranges are invalid.
 */
export function validateLlmConfig(config: LlmConfig): LlmConfig {
  assertUrl(config.baseUrl, "llm.baseUrl");
  assertNonEmpty(config.apiKey, "llm.apiKey");
  assertNonEmpty(config.model, "llm.model");
  if (
    config.temperature !== undefined &&
    (!Number.isFinite(config.temperature) ||
      config.temperature < 0 ||
      config.temperature > 2)
  ) {
    throw new ConfigurationError("llm.temperature must be between 0 and 2");
  }
  if (
    config.maxTokens !== undefined &&
    (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0)
  ) {
    throw new ConfigurationError("llm.maxTokens must be a positive number");
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new ConfigurationError("llm.timeoutMs must be a positive number");
  }
  return {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: config.apiKey,
    model: config.model.trim(),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

function validateRetrievalConfig(config: RetrievalConfig): RetrievalConfig {
  if (config === null || typeof config !== "object") {
    throw new ConfigurationError("retrieval must be an object");
  }

  const out: RetrievalConfig = {};

  if (config.overFetchFactor !== undefined) {
    assertFiniteNumber(config.overFetchFactor, "retrieval.overFetchFactor");
    assertNumberMin(config.overFetchFactor, "retrieval.overFetchFactor", 0);
    if (config.overFetchFactor <= 0) {
      throw new ConfigurationError("retrieval.overFetchFactor must be > 0");
    }
    out.overFetchFactor = config.overFetchFactor;
  }

  if (config.hybrid !== undefined) {
    if (config.hybrid === null || typeof config.hybrid !== "object") {
      throw new ConfigurationError("retrieval.hybrid must be an object");
    }
    const hybrid = config.hybrid;
    const outHybrid: NonNullable<RetrievalConfig["hybrid"]> = {};

    if (hybrid.semanticWeight !== undefined) {
      assertFiniteNumber(hybrid.semanticWeight, "retrieval.hybrid.semanticWeight");
      if (hybrid.semanticWeight < 0) {
        throw new ConfigurationError(
          "retrieval.hybrid.semanticWeight must be >= 0",
        );
      }
      outHybrid.semanticWeight = hybrid.semanticWeight;
    }

    if (hybrid.keywordWeight !== undefined) {
      assertFiniteNumber(hybrid.keywordWeight, "retrieval.hybrid.keywordWeight");
      if (hybrid.keywordWeight < 0) {
        throw new ConfigurationError(
          "retrieval.hybrid.keywordWeight must be >= 0",
        );
      }
      outHybrid.keywordWeight = hybrid.keywordWeight;
    }

    if (Object.keys(outHybrid).length > 0) {
      out.hybrid = outHybrid;
    }
  }

  if (config.mmr !== undefined) {
    if (config.mmr === null || typeof config.mmr !== "object") {
      throw new ConfigurationError("retrieval.mmr must be an object");
    }
    const mmr = config.mmr;
    const outMmr: NonNullable<RetrievalConfig["mmr"]> = {};

    if (mmr.lambda !== undefined) {
      assertFiniteNumber(mmr.lambda, "retrieval.mmr.lambda");
      assertNumberInRange(mmr.lambda, "retrieval.mmr.lambda", 0, 1);
      outMmr.lambda = mmr.lambda;
    }

    if (Object.keys(outMmr).length > 0) {
      out.mmr = outMmr;
    }
  }

  return out;
}

function validateMemoryDedupeConfig(config: MemoryDedupeConfig): MemoryDedupeConfig {
  if (config === null || typeof config !== "object") {
    throw new ConfigurationError("memory.dedupe must be an object");
  }
  const out: MemoryDedupeConfig = {};

  if (config.enabled !== undefined) {
    if (typeof config.enabled !== "boolean") {
      throw new ConfigurationError("memory.dedupe.enabled must be a boolean");
    }
    out.enabled = config.enabled;
  }

  if (config.strategy !== undefined) {
    const allowed = new Set(["exact", "near", "exact-or-near"]);
    if (!allowed.has(config.strategy)) {
      throw new ConfigurationError(
        `memory.dedupe.strategy must be one of ${Array.from(allowed).join(", ")}`,
      );
    }
    out.strategy = config.strategy;
  }

  if (config.nearThreshold !== undefined) {
    assertFiniteNumber(config.nearThreshold, "memory.dedupe.nearThreshold");
    assertNumberInRange(
      config.nearThreshold,
      "memory.dedupe.nearThreshold",
      0,
      1,
    );
    out.nearThreshold = config.nearThreshold;
  }

  if (config.nearCandidateLimit !== undefined) {
    assertFiniteNumber(
      config.nearCandidateLimit,
      "memory.dedupe.nearCandidateLimit",
    );
    assertNumberMin(
      config.nearCandidateLimit,
      "memory.dedupe.nearCandidateLimit",
      1,
    );
    out.nearCandidateLimit = config.nearCandidateLimit;
  }

  return out;
}

function validateEmbeddingCacheConfig(
  config: EmbeddingCacheConfig,
): EmbeddingCacheConfig {
  if (config === null || typeof config !== "object") {
    throw new ConfigurationError("embeddingCache must be an object");
  }

  const out: EmbeddingCacheConfig = {};

  if (config.enabled !== undefined) {
    if (typeof config.enabled !== "boolean") {
      throw new ConfigurationError("embeddingCache.enabled must be a boolean");
    }
    out.enabled = config.enabled;
  }

  if (config.ttlMs !== undefined) {
    assertFiniteNumber(config.ttlMs, "embeddingCache.ttlMs");
    if (config.ttlMs < 0) {
      throw new ConfigurationError("embeddingCache.ttlMs must be >= 0");
    }
    out.ttlMs = config.ttlMs;
  }

  if (config.maxEntries !== undefined) {
    assertFiniteNumber(config.maxEntries, "embeddingCache.maxEntries");
    if (config.maxEntries < 0) {
      throw new ConfigurationError("embeddingCache.maxEntries must be >= 0");
    }
    out.maxEntries = config.maxEntries;
  }

  return out;
}

/**
 * Normalize SQLite or PostgreSQL database configuration.
 *
 * Resolves `url` / `connectionString` aliases and validates the provider name.
 *
 * @param config - Storage or database config object.
 * @returns Normalized {@link DatabaseConfig} with both `url` and `connectionString` set.
 */
export function normalizeDatabaseConfig(
  config: DatabaseConfig | StorageConfig,
): DatabaseConfig {
  const provider = config.provider;
  if (provider !== "sqlite" && provider !== "postgres") {
    throw new ConfigurationError(
      `Unsupported database provider "${String((config as { provider?: string }).provider)}". Supported: "sqlite", "postgres".`,
    );
  }
  const connectionString = resolveDatabaseUrl(config).trim();
  assertNonEmpty(connectionString, "database.url / database.connectionString");

  if (provider === "postgres") {
    return {
      provider: "postgres",
      connectionString,
      url: connectionString,
      ...("maxPoolSize" in config && config.maxPoolSize !== undefined
        ? { maxPoolSize: config.maxPoolSize }
        : {}),
      ...("durableWrites" in config && config.durableWrites !== undefined
        ? { durableWrites: config.durableWrites }
        : {}),
    };
  }
  return {
    provider: "sqlite",
    connectionString,
    url: connectionString,
  };
}

/**
 * Validate telemetry configuration (independent database from memory storage).
 *
 * @param config - Telemetry block from `wolbarg({ telemetry })`.
 * @returns Normalized config with defaults for capture flags and log level.
 * @throws {@link ConfigurationError} for unsupported providers (Neo4j/Kuzu) or missing URL.
 */
export function validateTelemetryConfig(config: TelemetryConfig): TelemetryConfig {
  if (!config.database || typeof config.database !== "object") {
    throw new ConfigurationError("telemetry.database is required when telemetry is enabled");
  }
  const providerName = String(
    (config.database as { provider?: string }).provider ?? "",
  );
  if (providerName === "kuzu" || providerName === "neo4j") {
    throw new ConfigurationError(
      `telemetry supports sqlite or postgres only (got "${providerName}")`,
      {
        reason: `provider=${providerName}`,
        suggestion:
          'Use telemetry: { database: { provider: "sqlite", url: "./telemetry.db" } }. Graph backends (kuzu/neo4j) are not valid telemetry stores.',
      },
    );
  }
  if (config.database.provider !== "sqlite") {
    throw new ConfigurationError(
      `Unsupported telemetry provider "${config.database.provider}". Only "sqlite" is implemented; PostgreSQL typed but not implemented. Telemetry supports sqlite or postgres only — not kuzu/neo4j.`,
      {
        reason: `provider=${config.database.provider}`,
        suggestion: 'Use telemetry: { database: { provider: "sqlite", url: "./telemetry.db" } }',
      },
    );
  }
  const url =
    config.database.url?.trim() ||
    config.database.connectionString?.trim() ||
    "";
  assertNonEmpty(url, "telemetry.database.url");

  const level = config.level ?? "info";
  const allowed = new Set(["off", "error", "warn", "info", "debug", "trace"]);
  if (!allowed.has(level)) {
    throw new ConfigurationError(`Invalid telemetry.level "${level}"`);
  }

  return {
    enabled: config.enabled ?? true,
    database: {
      provider: "sqlite",
      url,
      connectionString: url,
    },
    level,
    captureQueries: config.captureQueries ?? true,
    captureLatency: config.captureLatency ?? true,
    captureErrors: config.captureErrors ?? true,
    captureSimilarity: config.captureSimilarity ?? true,
    captureEmbeddings: config.captureEmbeddings ?? false,
  };
}

/**
 * Validate and normalize init options (v0.1 compatibility entry point).
 *
 * @param options - Legacy `init()` shape with organization, database, embedding, optional llm.
 * @returns Trimmed organization and normalized nested configs.
 */
export function validateInitOptions(options: InitOptions): InitOptions {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("init options must be an object");
  }

  assertNonEmpty(options.organization, "organization");

  if (!options.database || typeof options.database !== "object") {
    throw new ConfigurationError("database configuration is required");
  }

  const database = normalizeDatabaseConfig(options.database);

  if (!options.embedding || typeof options.embedding !== "object") {
    throw new ConfigurationError("embedding configuration is required");
  }

  const embedding = validateEmbeddingConfig(options.embedding);
  const llm = options.llm ? validateLlmConfig(options.llm) : undefined;

  return {
    organization: options.organization.trim(),
    database,
    embedding,
    ...(llm ? { llm } : {}),
  };
}

function resolveStorageInput(options: WolbargOptions): StorageInput {
  if (options.storage && options.database) {
    throw new ConfigurationError(
      "Pass either storage or database, not both",
    );
  }
  const input = options.storage ?? options.database;
  if (!input) {
    throw new ConfigurationError("storage or database is required");
  }
  return input;
}

/**
 * Validate and normalize the full `wolbarg()` constructor options object.
 *
 * Resolves storage/database aliases, validates retrieval, dedupe, embedding cache,
 * telemetry, and graph inputs.
 *
 * @param options - Raw constructor options.
 * @returns Normalized options safe for Wolbarg construction.
 * @throws {@link ConfigurationError} on invalid or conflicting configuration.
 */
export function validateWolbargOptions(options: WolbargOptions): WolbargOptions {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("Wolbarg options must be an object");
  }
  assertNonEmpty(options.organization, "organization");

  const checkpointDirectory =
    options.checkpointDirectory !== undefined
      ? (() => {
          assertNonEmpty(options.checkpointDirectory, "checkpointDirectory");
          return options.checkpointDirectory.trim();
        })()
      : undefined;

  const storageInput = resolveStorageInput(options);
  let storage: StorageInput = storageInput;
  if (!isStorageProvider(storageInput)) {
    storage = normalizeDatabaseConfig(storageInput);
  }

  if (
    !isStorageProvider(storageInput) &&
    storageInput.provider === "postgres" &&
    storageInput.maxPoolSize !== undefined
  ) {
    assertFiniteNumber(
      storageInput.maxPoolSize,
      "database.maxPoolSize",
    );
    assertNumberMin(storageInput.maxPoolSize, "database.maxPoolSize", 1);
  }

  if (!options.embedding) {
    throw new ConfigurationError("embedding is required");
  }
  if (!isEmbeddingProvider(options.embedding)) {
    validateEmbeddingConfig(options.embedding);
  }

  if (options.llm !== undefined && !isLlmProvider(options.llm)) {
    validateLlmConfig(options.llm);
  }

  let telemetry = options.telemetry;
  if (telemetry && !isTelemetryProvider(telemetry)) {
    telemetry = validateTelemetryConfig(telemetry);
  }

  let graph = options.graph;
  if (graph !== undefined) {
    graph = resolveGraphInput(graph);
  }

  const retrieval =
    options.retrieval !== undefined ? validateRetrievalConfig(options.retrieval) : undefined;

  const embeddingCache =
    options.embeddingCache !== undefined
      ? validateEmbeddingCacheConfig(options.embeddingCache)
      : undefined;

  const memory =
    options.memory !== undefined && options.memory.dedupe !== undefined
      ? { ...options.memory, dedupe: validateMemoryDedupeConfig(options.memory.dedupe) }
      : options.memory;

  return {
    ...options,
    organization: options.organization.trim(),
    storage,
    database: undefined,
    ...(telemetry ? { telemetry } : {}),
    ...(graph !== undefined ? { graph } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    ...(embeddingCache !== undefined ? { embeddingCache } : {}),
    ...(checkpointDirectory !== undefined ? { checkpointDirectory } : {}),
    ...(memory !== undefined ? { memory } : {}),
  };
}

/**
 * Accept a {@link GraphProvider} instance or `{ provider: "sqlite" | "neo4j", … }` config.
 *
 * Instantiates built-in SQLite / Neo4j providers from config objects.
 *
 * @param input - Graph provider instance or config.
 * @returns Resolved {@link GraphProvider} ready for `open()`.
 * @throws {@link ConfigurationError} on garbage input or unsupported provider names.
 *
 * @example
 * ```ts
 * const graph = resolveGraphInput({ provider: "sqlite", path: "./graph.db" });
 * ```
 */
export function resolveGraphInput(input: GraphInput): GraphProvider {
  if (input == null || typeof input !== "object") {
    throw new ConfigurationError(
      "graph must be a GraphProvider instance or a config object",
      {
        suggestion:
          "Use graph: sqliteGraph({ path }) or graph: neo4jGraph({ url, username, password })",
      },
    );
  }
  if (Array.isArray(input)) {
    throw new ConfigurationError(
      "graph must be a GraphProvider instance or a config object",
      {
        suggestion:
          "Use graph: sqliteGraph({ path }) or graph: neo4jGraph({ url, username, password })",
      },
    );
  }
  if (isGraphProvider(input)) {
    return input;
  }
  const config = input as GraphConfig;
  if (config.provider === "sqlite") {
    if (typeof config.path !== "string" || !config.path.trim()) {
      throw new ConfigurationError(
        'graph sqlite config requires a non-empty "path"',
      );
    }
    return new SqliteGraphProvider({ path: config.path });
  }
  if (config.provider === "neo4j") {
    if (typeof config.url !== "string" || !config.url.trim()) {
      throw new ConfigurationError('graph neo4j config requires a non-empty "url"');
    }
    if (typeof config.username !== "string" || !config.username.trim()) {
      throw new ConfigurationError(
        'graph neo4j config requires a non-empty "username"',
      );
    }
    if (typeof config.password !== "string") {
      throw new ConfigurationError('graph neo4j config requires a "password" string');
    }
    return new Neo4jGraphProvider({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
    });
  }
  throw new ConfigurationError(
    `Unsupported graph provider "${String((config as { provider?: string }).provider)}". Supported: "sqlite", "neo4j", or a GraphProvider instance.`,
    {
      suggestion:
        'Use graph: sqliteGraph({ path: "./local-graph.db" }) or graph: neo4jGraph({ url, username, password })',
    },
  );
}
