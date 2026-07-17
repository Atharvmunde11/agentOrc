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

  constructor(options: SqliteTelemetryProviderOptions) {
    this.db = new SqliteEventDatabase({ url: options.url });
  }

  async open(): Promise<void> {
    if (!this.openPromise) {
      this.openPromise = this.db.open();
    }
    await this.openPromise;
    this.closed = false;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await this.db.close();
    this.openPromise = null;
  }

  emit(event: TelemetryEventInput): void {
    if (this.closed) {
      return;
    }
    this.queue.push(event);
    void this.scheduleFlush();
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.flushing) {
      await this.scheduleFlush();
      if (this.flushing) {
        await this.flushing;
      }
    }
  }

  async query(options: TelemetryQuery): Promise<TelemetryQueryResult> {
    await this.open();
    return this.db.query(options);
  }

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
    } catch {
      // Telemetry must never crash the host application.
      // Drop failed batch rather than re-queue forever.
    }
  }
}
