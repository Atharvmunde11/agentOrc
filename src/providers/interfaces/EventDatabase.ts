/**
 * Internal event persistence contract.
 * Distinct from MemoryDatabase / StorageProvider — telemetry never shares tables.
 */

import type {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";

export interface EventDatabase {
  readonly name: string;

  open(): Promise<void>;
  close(): Promise<void>;

  /** Insert one event row. */
  insertEvent(event: TelemetryEventInput): Promise<TelemetryEvent>;

  /** Insert many events in one batch (optional optimization). */
  insertEvents?(events: TelemetryEventInput[]): Promise<TelemetryEvent[]>;

  query(options: TelemetryQuery): Promise<TelemetryQueryResult>;

  getEvent(id: string): Promise<TelemetryEvent | null>;

  /** Aggregate helpers used by Studio backends. */
  countEvents?(filter?: { since?: string; operation?: string }): Promise<number>;
}
