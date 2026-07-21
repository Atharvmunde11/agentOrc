/**
 * SQLite TelemetryProvider backed by an independent EventDatabase.
 * Writes are queued and flushed asynchronously so memory ops stay fast.
 */

import type { TelemetryProvider } from "../interfaces/TelemetryProvider.js";
import type {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";
import { SqliteEventDatabase } from "./sqliteEventDatabase.js";

const MAX_QUEUE_SIZE = 10_000;

export interface SqliteTelemetryProviderOptions {
  url: string;
}

export class SqliteTelemetryProvider implements TelemetryProvider {
  readonly name = "sqlite";
  private readonly db: SqliteEventDatabase;
  private queue: TelemetryEventInput[] = [];
  private flushing: Promise<void> | null = null;
  private closed = false;
  private openPromise: Promise<void> | null = null;
  private warnedQueueDrop = false;
  private warnedFlushFailure = false;

  /**
   * @param options.url - Path to the independent telemetry SQLite database file.
   */
  constructor(options: SqliteTelemetryProviderOptions) {
    this.db = new SqliteEventDatabase({ url: options.url });
  }

  /** Open the telemetry EventDatabase (lazy — also invoked on first emit). */
  async open(): Promise<void> {
    if (!this.openPromise) {
      this.openPromise = this.db.open();
    }
    await this.openPromise;
    this.closed = false;
  }

  /** Flush pending events and close the telemetry database. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await this.db.close();
    this.openPromise = null;
  }

  /**
   * Enqueue a telemetry event for async persistence (never throws).
   *
   * @param event - Partial or complete {@link TelemetryEventInput}.
   */
  emit(event: TelemetryEventInput): void {
    if (this.closed) {
      return;
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Drop oldest to keep memory bounded under sustained write failures.
      this.queue.shift();
      if (!this.warnedQueueDrop) {
        this.warnedQueueDrop = true;
        console.warn(
          `[wolbarg telemetry] event queue capped at ${MAX_QUEUE_SIZE}; dropping oldest events`,
        );
      }
    }
    this.queue.push(event);
    void this.scheduleFlush();
  }

  /** Block until all queued events are written (or dropped on failure). */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.flushing) {
      await this.scheduleFlush();
      if (this.flushing) {
        await this.flushing;
      }
    }
  }

  /** Query persisted telemetry events with filters and pagination. */
  async query(options: TelemetryQuery): Promise<TelemetryQueryResult> {
    await this.open();
    return this.db.query(options);
  }

  /** Fetch a single telemetry event by id. */
  async getEvent(id: string): Promise<TelemetryEvent | null> {
    await this.open();
    return this.db.getEvent(id);
  }

  private scheduleFlush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    this.flushing = this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    await this.open();
    const batch = this.queue.splice(0, this.queue.length);
    try {
      if (typeof this.db.insertEvents === "function") {
        await this.db.insertEvents(batch);
      } else {
        for (const event of batch) {
          await this.db.insertEvent(event);
        }
      }
    } catch (error) {
      // Telemetry must never crash the host application.
      // Drop failed batch rather than re-queue forever.
      if (!this.warnedFlushFailure) {
        this.warnedFlushFailure = true;
        console.warn(
          `[wolbarg telemetry] flush failed; dropping batch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
