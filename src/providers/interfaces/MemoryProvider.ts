/**
 * Database-agnostic memory persistence contract.
 * Alias of StorageProvider for the v0.3 provider architecture.
 */

import type { StorageProvider } from "../../storage/types.js";

/** Memory / vector storage provider. Implementations: SQLite, PostgreSQL. */
export type MemoryProvider = StorageProvider;
