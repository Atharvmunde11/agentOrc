/**
 * Database-agnostic memory persistence contract.
 *
 * Alias of {@link StorageProvider} for the v0.3+ provider architecture naming.
 * Custom memory backends should implement {@link StorageProvider} in
 * `sdk/src/storage/types.ts` — this type is a semantic alias only.
 */

import type { StorageProvider } from "../../storage/types.js";

/**
 * Memory / vector storage provider.
 *
 * Built-in implementations: {@link SqliteStorageProvider}, {@link PostgresStorageProvider}.
 *
 * @example
 * ```ts
 * import type { MemoryProvider } from "wolbarg/providers";
 *
 * function useStorage(provider: MemoryProvider) {
 *   return provider.getMemoryById(id, org);
 * }
 * ```
 */
export type MemoryProvider = StorageProvider;
