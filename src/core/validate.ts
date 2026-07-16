/**
 * Configuration validation for SDK initialization and constructor options.
 */

import type { WolbargOptions } from "./options.js";
import type { EmbeddingConfig, InitOptions, LlmConfig } from "../types/index.js";
import { ConfigurationError } from "../errors/index.js";
import { isEmbeddingProvider, isLlmProvider, isStorageProvider } from "./options.js";

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

/**
 * Validate and normalize init options (v0.1 compat).
 * LLM is optional in v0.2.
 */
export function validateInitOptions(options: InitOptions): InitOptions {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("init options must be an object");
  }

  assertNonEmpty(options.organization, "organization");

  if (!options.database || typeof options.database !== "object") {
    throw new ConfigurationError("database configuration is required");
  }

  const provider = options.database.provider;
  if (provider !== "sqlite" && provider !== "postgres") {
    throw new ConfigurationError(
      `Unsupported database provider "${String((options.database as { provider?: string }).provider)}". Supported: "sqlite", "postgres".`,
    );
  }

  assertNonEmpty(
    options.database.connectionString,
    "database.connectionString",
  );

  if (!options.embedding || typeof options.embedding !== "object") {
    throw new ConfigurationError("embedding configuration is required");
  }

  const embedding = validateEmbeddingConfig(options.embedding);
  const llm = options.llm ? validateLlmConfig(options.llm) : undefined;

  return {
    organization: options.organization.trim(),
    database:
      provider === "postgres"
        ? {
            provider: "postgres",
            connectionString: options.database.connectionString.trim(),
            ...("maxPoolSize" in options.database &&
            options.database.maxPoolSize !== undefined
              ? { maxPoolSize: options.database.maxPoolSize }
              : {}),
          }
        : {
            provider: "sqlite",
            connectionString: options.database.connectionString.trim(),
          },
    embedding,
    ...(llm ? { llm } : {}),
  };
}

export function validateWolbargOptions(options: WolbargOptions): WolbargOptions {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("Wolbarg options must be an object");
  }
  assertNonEmpty(options.organization, "organization");

  if (!options.storage) {
    throw new ConfigurationError("storage is required");
  }
  if (!isStorageProvider(options.storage)) {
    if (
      typeof options.storage !== "object" ||
      !("provider" in options.storage) ||
      !("connectionString" in options.storage)
    ) {
      throw new ConfigurationError("storage must be a provider instance or config");
    }
    assertNonEmpty(options.storage.connectionString, "storage.connectionString");
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

  return {
    ...options,
    organization: options.organization.trim(),
  };
}
