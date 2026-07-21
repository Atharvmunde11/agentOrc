/**
 * Public subscribe() types for real-time memory change events.
 *
 * Agents and dashboards use these types with `wolbarg.subscribe()` to receive
 * push notifications when memories are created, updated, forgotten, compressed, or ingested.
 *
 * @example
 * ```ts
 * const unsub = wolbarg.subscribe(
 *   { organization: "acme", event: "remember" },
 *   (event) => console.log(event.memoryId),
 * );
 * ```
 */

/** Event names that can be filtered in {@link SubscribeFilter.event}. */
export type SubscribableEvent =
  | "remember"
  | "update"
  | "forget"
  | "compress"
  | "ingest"
  | "*";

/** Filter passed to `wolbarg.subscribe()` to scope notifications. */
export interface SubscribeFilter {
  /** Organization namespace (required). */
  organization: string;
  /** Optional agent id — omit to receive events for all agents. */
  agent?: string;
  /** Single event, list of events, or `"*"` for all (default all when omitted). */
  event?: SubscribableEvent | SubscribableEvent[];
}

/** Payload delivered to {@link MemoryChangeCallback} listeners. */
export interface MemoryChangeEvent {
  /** Operation that triggered the notification. */
  event: Exclude<SubscribableEvent, "*">;
  /** Organization namespace. */
  organization: string;
  /** Agent that performed the operation. */
  agent: string;
  /** Affected memory id, or multiple ids for batch operations. */
  memoryId: string | string[];
  /** ISO-8601 timestamp when the change occurred. */
  timestamp: string;
  /** Optional telemetry trace id linking to observability events. */
  traceId?: string;
  /** Optional session id from the originating SDK instance. */
  sessionId?: string;
  /** Present when upsert path ran during remember/ingest. */
  upsertAction?: "created" | "updated" | "skipped";
}

/** Callback invoked for each matching memory change event. */
export type MemoryChangeCallback = (event: MemoryChangeEvent) => void;

/** Function returned from subscribe — call to remove the listener. */
export type Unsubscribe = () => void;

/**
 * Internal subscribe backend contract (SQLite emitter or Postgres LISTEN).
 *
 * Implementations must fan out {@link MemoryChangeEvent} to registered callbacks
 * and support clean shutdown via {@link SubscribeBackend.close}.
 */
export interface SubscribeBackend {
  /**
   * Register a listener for events matching `filter`.
   * @param filter - Organization/agent/event scope.
   * @param callback - Handler invoked synchronously on each event.
   * @returns Call to unregister this listener.
   */
  subscribe(
    filter: SubscribeFilter,
    callback: MemoryChangeCallback,
  ): Unsubscribe;
  /** Broadcast an event to all matching subscribers (used internally after writes). */
  emit(event: MemoryChangeEvent): void;
  /** Release listeners and underlying connections. */
  close(): Promise<void>;
}
