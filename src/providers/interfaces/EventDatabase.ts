/**
 * Internal event persistence contract for telemetry storage.
 *
 * Distinct from {@link MemoryProvider} — telemetry MUST use separate tables/database.
 */

import type {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";

/**
 * Low-level event database used by {@link TelemetryProvider} implementations.
 *
 * Implement this interface when adding a new telemetry backend (e.g. Postgres events).
 *
 * @example
 * ```ts
 * class MyEventDb implements EventDatabase {
 *   readonly name = "my-events";
 *   async open() { /* migrate schema *\/ }
 *   async close() {}
 *   async insertEvent(input) { /* persist *\/ return { ...input, id: "...", timestamp: "..." }; }
 *   async query(options) { return { events: [], total: 0, limit: 0, offset: 0 }; }
 *   async getEvent(id) { return null; }
 * }
 * ```
 */
export interface EventDatabase {
  /** Backend identifier. */
  readonly name: string;

  /** Open connection and ensure event schema. */
  open(): Promise<void>;

  /** Close connection and flush pending writes. */
  close(): Promise<void>;

  /**
   * Insert one telemetry event row.
   * @param event - Event input (id/timestamp may be assigned by the backend).
   */
  insertEvent(event: TelemetryEventInput): Promise<TelemetryEvent>;

  /**
   * Batch insert events (optional optimization).
   * @param events - Non-empty event batch.
   */
  insertEvents?(events: TelemetryEventInput[]): Promise<TelemetryEvent[]>;

  /**
   * Query persisted events (Studio / debugging).
   * @param options - Filters, pagination, and sort order.
   */
  query(options: TelemetryQuery): Promise<TelemetryQueryResult>;

  /**
   * Fetch a single event by id.
   * @param id - Event UUID.
   */
  getEvent(id: string): Promise<TelemetryEvent | null>;

  /**
   * Aggregate helpers used by Studio dashboards (optional).
   * @param filter - Optional time and operation filters.
   */
  countEvents?(filter?: { since?: string; operation?: string }): Promise<number>;
}
