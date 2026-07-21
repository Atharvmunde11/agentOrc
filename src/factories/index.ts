/**
 * Public factory helpers for storage, telemetry, checkpoints, and graph providers (v0.5.5).
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
import { SqliteGraphProvider } from "../graph/providers/sqlite-graph.js";
import { Neo4jGraphProvider } from "../graph/providers/neo4j.js";
import type { GraphProvider } from "../graph/types.js";
import { ConfigurationError } from "../errors/index.js";
import type { WolbargOptions } from "../core/options.js";
import { Wolbarg } from "../core/wolbarg.js";

/**
 * Create a SQLite {@link StorageProvider} from a filesystem path or `:memory:`.
 *
 * @param connectionString - Absolute/relative `.db` path, or `":memory:"` for ephemeral.
 * @returns Ready-to-pass storage provider (Wolbarg still calls `open()` via `ready()`).
 *
 * @example
 * ```ts
 * wolbarg({ organization: "acme", storage: sqlite("./memory.db"), embedding: ... })
 * ```
 */
export function sqlite(connectionString: string): StorageProvider {
  return new SqliteStorageProvider({ connectionString });
}

/**
 * Create a SQLite storage **config object** (for `database` / `init` options).
 *
 * @param connectionString - Path or `:memory:`.
 * @returns `{ provider: "sqlite", connectionString, url }`.
 */
export function sqliteConfig(
  connectionString: string,
): SqliteDatabaseConfig {
  return {
    provider: "sqlite",
    connectionString,
    url: connectionString,
  };
}

/**
 * Create a PostgreSQL {@link StorageProvider}. Requires optional peer `pg`.
 *
 * @param options - Connection string, or an object with:
 *   - `connectionString` — Postgres URL
 *   - `maxPoolSize` — optional pool size
 *   - `durableWrites` — default `true`; set `false` for higher write throughput (async commit)
 * @returns Postgres storage provider instance.
 *
 * @example
 * ```ts
 * postgres(process.env.DATABASE_URL!)
 * postgres({ connectionString: process.env.DATABASE_URL!, maxPoolSize: 10 })
 * ```
 */
export function postgres(
  options:
    | string
    | {
        connectionString: string;
        maxPoolSize?: number;
        /** Default true. Set false for higher write throughput (async commit). */
        durableWrites?: boolean;
      },
): StorageProvider {
  const opts =
    typeof options === "string"
      ? { connectionString: options }
      : options;
  return new PostgresStorageProvider(opts);
}

/**
 * Create a PostgreSQL storage **config object**.
 *
 * @param connectionString - Postgres connection URL.
 * @param options.maxPoolSize - Optional pool size.
 * @param options.durableWrites - Optional durability flag (default true).
 * @returns `{ provider: "postgres", connectionString, url, ... }`.
 */
export function postgresConfig(
  connectionString: string,
  options?: { maxPoolSize?: number; durableWrites?: boolean },
): PostgresDatabaseConfig {
  return {
    provider: "postgres",
    connectionString,
    url: connectionString,
    ...options,
  };
}

/**
 * Create a SQLite {@link TelemetryProvider} for an independent event database.
 *
 * @param url - Path to the telemetry SQLite file (separate from memory DB).
 * @returns Telemetry provider for `telemetry:` constructor option.
 */
export function sqliteTelemetry(url: string): TelemetryProvider {
  return new SqliteTelemetryProvider({ url });
}

/**
 * Create a SQLite {@link CheckpointProvider}.
 *
 * @param directory - Optional directory for checkpoint files (default under cwd).
 * @returns Checkpoint provider for `checkpoint:` constructor option.
 */
export function sqliteCheckpoint(directory?: string): CheckpointProvider {
  return new SqliteCheckpointProvider({ directory });
}

/**
 * Create an embedded SQLite {@link GraphProvider} (file-backed, local/dev).
 *
 * @param options.path - Filesystem path for the graph SQLite database
 *   (separate from the memory DB).
 * @returns Graph provider for `graph:` in {@link WolbargOptions}.
 *
 * @example
 * ```ts
 * graph: sqliteGraph({ path: "./graph.db" })
 * ```
 */
export function sqliteGraph(options: { path: string }): GraphProvider {
  return new SqliteGraphProvider(options);
}

/**
 * Create a Neo4j {@link GraphProvider} (networked). Requires optional peer `neo4j-driver`.
 *
 * @param options.url - Bolt URL, e.g. `neo4j://localhost:7687` or `bolt://…`.
 * @param options.username - Neo4j username.
 * @param options.password - Neo4j password.
 * @param options.database - Optional database name (Neo4j 4+ multi-DB).
 * @returns Graph provider for `graph:` in {@link WolbargOptions}.
 *
 * @example
 * ```ts
 * graph: neo4jGraph({
 *   url: "neo4j://localhost:7687",
 *   username: "neo4j",
 *   password: process.env.NEO4J_PASSWORD!,
 * })
 * ```
 */
export function neo4jGraph(options: {
  url: string;
  username: string;
  password: string;
  database?: string;
}): GraphProvider {
  return new Neo4jGraphProvider(options);
}

/**
 * Create a {@link TelemetryProvider} from {@link TelemetryConfig}.
 * Currently only SQLite telemetry databases are implemented.
 *
 * @param config - Telemetry config with `database.provider` and `database.url`.
 * @returns SQLite telemetry provider instance.
 * @throws {ConfigurationError} If provider is not `"sqlite"` or url is missing.
 */
export function createTelemetryProvider(
  config: TelemetryConfig,
): TelemetryProvider {
  if (config.database.provider !== "sqlite") {
    throw new ConfigurationError(
      `Unsupported telemetry provider "${config.database.provider}". Only "sqlite" is implemented. Telemetry supports sqlite or postgres only — not kuzu/neo4j.`,
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
 * Preferred factory. Equivalent to `new Wolbarg(options)`.
 *
 * @param options - Full {@link WolbargOptions} (providers, database, embedding, optional llm).
 * @returns Configured {@link Wolbarg} instance — call `ready()` before use.
 *
 * @example
 * ```ts
 * const ctx = wolbarg({
 *   organization: "acme",
 *   database: sqliteConfig("./memory.db"),
 *   embedding: openaiEmbedding({ apiKey: "...", model: "text-embedding-3-small" }),
 * });
 * await ctx.ready();
 * ```
 */
export function wolbarg(options: WolbargOptions): Wolbarg {
  return new Wolbarg(options as never);
}

/** @deprecated Alias of {@link wolbarg}. */
export const createWolbarg = wolbarg;
