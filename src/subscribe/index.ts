/**
 * Subscribe module re-exports — real-time memory change notifications.
 *
 * SQLite uses in-process {@link SqliteSubscribeEmitter}; PostgreSQL uses
 * {@link PostgresSubscribeListener} with `NOTIFY` on channel
 * {@link WOLBARG_NOTIFY_CHANNEL}.
 */

export type {
  MemoryChangeCallback,
  MemoryChangeEvent,
  SubscribableEvent,
  SubscribeBackend,
  SubscribeFilter,
  Unsubscribe,
} from "./types.js";

/** In-process event bus for file-backed SQLite deployments. */
export { SqliteSubscribeEmitter } from "./sqlite-emitter.js";
export {
  PostgresSubscribeListener,
  createPostgresListenerFromPool,
  notifyMemoryChange,
  serializeNotifyPayload,
  parseNotifyPayload,
  WOLBARG_NOTIFY_CHANNEL,
} from "./postgres-listener.js";
