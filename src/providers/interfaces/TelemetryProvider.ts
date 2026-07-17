/**
 * Database-agnostic telemetry persistence contract.
 * Telemetry MUST use a separate database from memory storage.
 */

import type {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";

export interface TelemetryProvider {
  readonly name: string;

  /** Open the independent event database connection. */
  open(): Promise<void>;

  /** Close the event database connection. Flush pending writes first. */
  close(): Promise<void>;

  /**
   * Persist a telemetry event. Must not block callers of memory operations.
   * Implementations may queue and flush asynchronously.
   */
  emit(event: TelemetryEventInput): void;

  /** Wait until the write queue is empty (used by tests / shutdown). */
  flush(): Promise<void>;

  /** Read events (primarily for Studio / debugging). Optional for write-only backends. */
  query?(options: TelemetryQuery): Promise<TelemetryQueryResult>;

  /** Fetch a single event by id. */
  getEvent?(id: string): Promise<TelemetryEvent | null>;
}
