/**
 * Configuration validation for SDK initialization and constructor options.
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
  InitOptions,
  LlmConfig,
  StorageConfig,
  TelemetryConfig,
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
 * Validate and normalize init options (v0.1 compat).
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

export function validateWolbargOptions(options: WolbargOptions): WolbargOptions {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("Wolbarg options must be an object");
  }
  assertNonEmpty(options.organization, "organization");

  const storageInput = resolveStorageInput(options);
  let storage: StorageInput = storageInput;
  if (!isStorageProvider(storageInput)) {
    storage = normalizeDatabaseConfig(storageInput);
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

  return {
    ...options,
    organization: options.organization.trim(),
    storage,
    database: undefined,
    ...(telemetry ? { telemetry } : {}),
    ...(graph !== undefined ? { graph } : {}),
  };
}

/**
 * Accept a GraphProvider instance or `{ provider: "sqlite" | "neo4j", … }` config.
 * Throws ConfigurationError on garbage input.
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
