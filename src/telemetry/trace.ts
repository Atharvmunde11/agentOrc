/**
 * Trace context helpers — `session_id`, `trace_id`, `parent_trace_id`.
 *
 * Used by {@link TelemetryEmitter} to correlate memory operations in Studio.
 */

import { createId } from "../utils/index.js";

/** Distributed trace context attached to telemetry events. */
export interface TraceContext {
  /** Wolbarg instance session id (stable for process lifetime). */
  sessionId: string;
  /** Unique id for this operation span. */
  traceId: string;
  /** Parent span id when nested, else `null`. */
  parentTraceId: string | null;
}

/** Create a new session id (UUID v4). */
export function createSessionId(): string {
  return createId();
}

/** Create a new trace id (UUID v4). */
export function createTraceId(): string {
  return createId();
}

/**
 * Create a root trace context for a top-level operation.
 *
 * @param sessionId - Session from {@link createSessionId} or {@link TelemetryEmitter.sessionId}.
 */
export function createRootTrace(sessionId: string): TraceContext {
  return {
    sessionId,
    traceId: createTraceId(),
    parentTraceId: null,
  };
}

/**
 * Create a child trace linked to a parent span.
 *
 * @param parent - Parent operation trace context.
 */
export function createChildTrace(parent: TraceContext): TraceContext {
  return {
    sessionId: parent.sessionId,
    traceId: createTraceId(),
    parentTraceId: parent.traceId,
  };
}
