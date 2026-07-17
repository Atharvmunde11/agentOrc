/**
 * Storage provider factory and re-exports.
 */

import type { DatabaseConfig, StorageConfig } from "../types/index.js";
import { ConfigurationError } from "../errors/index.js";
import { resolveDatabaseUrl } from "../core/options.js";
import type { StorageProvider } from "./types.js";
import { SqliteStorageProvider } from "./providers/sqlite.js";
import { PostgresStorageProvider } from "./providers/postgres.js";

export function createStorageProvider(
  config: StorageConfig | DatabaseConfig,
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
    });
  }

  if (config.provider === "postgres") {
    return new PostgresStorageProvider({
      connectionString,
      maxPoolSize: config.maxPoolSize,
    });
  }

  throw new ConfigurationError(
    `Unsupported storage provider: ${String((config as { provider: string }).provider)}`,
  );
}

/** @deprecated Prefer {@link createStorageProvider}. */
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
