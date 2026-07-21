/**
 * Database module — re-exports {@link StorageProvider} under the legacy `database` path.
 *
 * Prefer importing from `wolbarg` / `./storage/index.js` in new code.
 *
 * @packageDocumentation
 */

export {
  createDatabaseProvider,
  createStorageProvider,
  SqliteDatabaseProvider,
  SqliteStorageProvider,
  PostgresStorageProvider,
} from "../storage/index.js";

export type {
  DatabaseProvider,
  StorageProvider,
  MemoryRow,
  HistoryRow,
  InsertMemoryInput,
  UpdateMemoryInput,
  RepositoryFilter,
  VectorSearchHit,
} from "../storage/types.js";
