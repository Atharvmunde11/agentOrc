/**
 * In-process EventEmitter backend for SQLite subscribe().
 *
 * Limitation: only delivers events within the same Node.js process.
 */

import { EventEmitter } from "node:events";
import type {
  MemoryChangeCallback,
  MemoryChangeEvent,
  SubscribeBackend,
  SubscribeFilter,
  SubscribableEvent,
  Unsubscribe,
} from "./types.js";

interface Subscription {
  filter: SubscribeFilter;
  callback: MemoryChangeCallback;
}

function matchesFilter(
  filter: SubscribeFilter,
  event: MemoryChangeEvent,
): boolean {
  if (filter.organization !== event.organization) {
    return false;
  }
  if (filter.agent !== undefined && filter.agent !== event.agent) {
    return false;
  }
  if (filter.event === undefined) {
    return true;
  }
  const events = Array.isArray(filter.event) ? filter.event : [filter.event];
  return events.some(
    (e: SubscribableEvent) => e === "*" || e === event.event,
  );
}

/** In-process {@link SubscribeBackend} for SQLite (same Node.js process only). */
export class SqliteSubscribeEmitter implements SubscribeBackend {
  private readonly emitter = new EventEmitter();
  private readonly subscriptions = new Map<number, Subscription>();
  private nextId = 1;
  private closed = false;

  constructor() {
    this.emitter.setMaxListeners(0);
    this.emitter.on("change", (event: MemoryChangeEvent) => {
      for (const sub of this.subscriptions.values()) {
        if (!matchesFilter(sub.filter, event)) {
          continue;
        }
        try {
          sub.callback(event);
        } catch (error) {
          // Never crash the write path.
          console.error(
            "[wolbarg] subscribe callback error:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    });
  }

  /**
   * Register a filtered callback for in-process memory change events.
   *
   * @param filter - Organization / agent / event-type filter.
   * @param callback - Invoked synchronously on each matching emit.
   * @returns Unsubscribe function.
   */
  subscribe(
    filter: SubscribeFilter,
    callback: MemoryChangeCallback,
  ): Unsubscribe {
    if (this.closed) {
      throw new Error("Subscribe backend is closed");
    }
    const id = this.nextId++;
    this.subscriptions.set(id, { filter, callback });
    return () => {
      this.subscriptions.delete(id);
    };
  }

  /** Emit a memory change event to registered subscribers. */
  emit(event: MemoryChangeEvent): void {
    if (this.closed) {
      return;
    }
    this.emitter.emit("change", event);
  }

  /** Remove all listeners and mark the emitter closed. */
  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
    this.emitter.removeAllListeners();
  }
}
