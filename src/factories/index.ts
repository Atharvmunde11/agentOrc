/**
 * Public factory helpers for storage / providers.
 */

import type {
  PostgresDatabaseConfig,
  SqliteDatabaseConfig,
  TelemetryConfig,
} from "../types/index.js";
import { SqliteStorageProvider } from "../storage/providers/sqlite.js";
import { PostgresStorageProvider } from "../storage/providers/postgres.js";
import type { StorageProvider } from "../storage/types.js";
import { SqliteTelemetryProvider } from "../providers/sqlite/sqliteTelemetryProvider.js";
import { SqliteCheckpointProvider } from "../providers/sqlite/sqliteCheckpointProvider.js";
import type { TelemetryProvider } from "../providers/interfaces/TelemetryProvider.js";
import type { CheckpointProvider } from "../providers/interfaces/CheckpointProvider.js";
import { ConfigurationError } from "../errors/index.js";
import type { WolbargOptions } from "../core/options.js";
import { Wolbarg } from "../core/wolbarg.js";

/** Create a SQLite storage provider from a path or `:memory:`. */
export function sqlite(connectionString: string): StorageProvider {
  return new SqliteStorageProvider({ connectionString });
}

/** Create a SQLite storage config object (for init / options). */
export function sqliteConfig(
  connectionString: string,
): SqliteDatabaseConfig {
  return {
    provider: "sqlite",
    connectionString,
    url: connectionString,
  };
}

/** Create a PostgreSQL storage provider. Requires optional peer dependency `pg`. */
export function postgres(
  options: string | { connectionString: string; maxPoolSize?: number },
): StorageProvider {
  const opts =
    typeof options === "string"
      ? { connectionString: options }
      : options;
  return new PostgresStorageProvider(opts);
}

/** Create a PostgreSQL storage config object. */
export function postgresConfig(
  connectionString: string,
  options?: { maxPoolSize?: number },
): PostgresDatabaseConfig {
  return {
    provider: "postgres",
    connectionString,
    url: connectionString,
    ...options,
  };
}

/** Create a SQLite telemetry provider for an independent event database. */
export function sqliteTelemetry(url: string): TelemetryProvider {
  return new SqliteTelemetryProvider({ url });
}

/** Create a SQLite checkpoint provider. */
export function sqliteCheckpoint(directory?: string): CheckpointProvider {
  return new SqliteCheckpointProvider({ directory });
}

/** Create a telemetry provider from config (SQLite only in v0.3). */
export function createTelemetryProvider(
  config: TelemetryConfig,
): TelemetryProvider {
  if (config.database.provider !== "sqlite") {
    throw new ConfigurationError(
      `Unsupported telemetry provider "${config.database.provider}". Only "sqlite" is implemented in v0.3.0.`,
    );
  }
  const url =
    config.database.url ?? config.database.connectionString ?? "";
  if (!url) {
    throw new ConfigurationError("telemetry.database.url is required");
  }
  return new SqliteTelemetryProvider({ url });
}

/**
 * Preferred v0.3 factory. Equivalent to `new Wolbarg(options)`.
 */
export function wolbarg(options: WolbargOptions): Wolbarg {
  return new Wolbarg(options as never);
}
