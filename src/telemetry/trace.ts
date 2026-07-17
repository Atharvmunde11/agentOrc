/**
 * Trace context helpers — session_id, trace_id, parent_trace_id.
 */

import { createId } from "../utils/index.js";

export interface TraceContext {
  sessionId: string;
  traceId: string;
  parentTraceId: string | null;
}

export function createSessionId(): string {
  return createId();
}

export function createTraceId(): string {
  return createId();
}

export function createRootTrace(sessionId: string): TraceContext {
  return {
    sessionId,
    traceId: createTraceId(),
    parentTraceId: null,
  };
}

export function createChildTrace(parent: TraceContext): TraceContext {
  return {
    sessionId: parent.sessionId,
    traceId: createTraceId(),
    parentTraceId: parent.traceId,
  };
}
