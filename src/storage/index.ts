/**
 * Storage provider factory and re-exports.
 *
 * Creates SQLite or PostgreSQL {@link StorageProvider} instances from config.
 * Prefer {@link createStorageProvider} over the deprecated {@link createDatabaseProvider}.
 *
 * @example
 * ```ts
 * import { createStorageProvider } from "wolbarg/storage";
 *
 * const storage = createStorageProvider({
 *   provider: "sqlite",
 *   url: "./memory.db",
 * });
 * await storage.open();
 * ```
 */

import type { DatabaseConfig, StorageConfig } from "../types/index.js";
import { ConfigurationError } from "../errors/index.js";
import { resolveDatabaseUrl } from "../core/options.js";
import type { StorageProvider } from "./types.js";
import { SqliteStorageProvider } from "./providers/sqlite.js";
import { PostgresStorageProvider } from "./providers/postgres.js";

/**
 * Create a storage provider from SQLite or PostgreSQL configuration.
 *
 * @param config - Storage or database config with `provider` and connection URL.
 * @param options - Optional SQLite concurrency tuning.
 * @param options.concurrency - Lock retry / timeout settings for SQLite writes.
 * @returns An unopened {@link StorageProvider} — call `open()` before use.
 * @throws {@link ConfigurationError} when URL or provider is invalid.
 *
 * @example
 * ```ts
 * const storage = createStorageProvider(
 *   { provider: "postgres", url: process.env.DATABASE_URL! },
 *   { concurrency: { maxRetries: 5 } },
 * );
 * ```
 */
export function createStorageProvider(
  config: StorageConfig | DatabaseConfig,
  options?: { concurrency?: import("../types/index.js").ConcurrencyConfig },
): StorageProvider {
  const connectionString = resolveDatabaseUrl(config);
  if (!connectionString) {
    throw new ConfigurationError(
      "database.url or database.connectionString is required",
    );
  }

  if (config.provider === "sqlite") {
    return new SqliteStorageProvider({
      connectionString,
      concurrency: options?.concurrency,
    });
  }

  if (config.provider === "postgres") {
    return new PostgresStorageProvider({
      connectionString,
      maxPoolSize: config.maxPoolSize,
      durableWrites: config.durableWrites,
    });
  }

  throw new ConfigurationError(
    `Unsupported storage provider: ${String((config as { provider: string }).provider)}`,
  );
}

/**
 * @deprecated Prefer {@link createStorageProvider}.
 * @param config - Legacy database configuration object.
 * @returns A {@link StorageProvider} instance.
 */
export function createDatabaseProvider(
  config: DatabaseConfig,
): StorageProvider {
  return createStorageProvider(config);
}

export type {
  StorageProvider,
  DatabaseProvider,
  MemoryRow,
  HistoryRow,
  InsertMemoryInput,
  UpdateMemoryInput,
  RepositoryFilter,
  VectorSearchHit,
} from "./types.js";
export {
  SqliteStorageProvider,
  SqliteDatabaseProvider,
} from "./providers/sqlite.js";
export { PostgresStorageProvider } from "./providers/postgres.js";
