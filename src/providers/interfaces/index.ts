/**
 * Provider interface re-exports for custom Wolbarg backends.
 *
 * Implement these contracts when building alternate storage, telemetry, checkpoint,
 * or event database adapters.
 */

export type { MemoryProvider } from "./MemoryProvider.js";
export type { TelemetryProvider } from "./TelemetryProvider.js";
export type {
  CheckpointProvider,
  CheckpointMeta,
  CreateCheckpointOptions,
} from "./CheckpointProvider.js";
export type { EventDatabase } from "./EventDatabase.js";
