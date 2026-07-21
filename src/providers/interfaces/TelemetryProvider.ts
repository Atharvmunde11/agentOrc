/**
 * Database-agnostic telemetry persistence contract.
 *
 * Telemetry MUST use a separate database from memory storage — never share tables.
 */

import type {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";

/**
 * Telemetry provider contract — async, non-blocking event emission.
 *
 * Implement this interface for custom observability sinks (OpenTelemetry export,
 * cloud logging, etc.). Built-in: SQLite telemetry via {@link SqliteTelemetryProvider}.
 *
 * @example Custom write-only provider
 * ```ts
 * const provider: TelemetryProvider = {
 *   name: "console",
 *   async open() {},
 *   async close() {},
 *   emit(event) { console.log(event.operation, event.durationMs); },
 *   async flush() {},
 * };
 * ```
 */
export interface TelemetryProvider {
  /** Provider identifier (e.g. `"sqlite-telemetry"`, `"noop"`). */
  readonly name: string;

  /** Open the independent event database connection. */
  open(): Promise<void>;

  /** Close the event database connection. Flush pending writes first. */
  close(): Promise<void>;

  /**
   * Persist a telemetry event. Must not block callers of memory operations.
   * Implementations may queue and flush asynchronously.
   *
   * @param event - Fully or partially populated event input.
   */
  emit(event: TelemetryEventInput): void;

  /** Wait until the write queue is empty (used by tests / graceful shutdown). */
  flush(): Promise<void>;

  /**
   * Read events (primarily for Studio / debugging). Optional for write-only backends.
   * @param options - Query filters and pagination.
   */
  query?(options: TelemetryQuery): Promise<TelemetryQueryResult>;

  /**
   * Fetch a single event by id.
   * @param id - Event UUID.
   */
  getEvent?(id: string): Promise<TelemetryEvent | null>;
}
