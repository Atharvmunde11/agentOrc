/**
 * Telemetry types, trace helpers, structured logging, and the async emitter.
 *
 * @packageDocumentation
 */

export type {
  TelemetryOperation,
  TelemetryStatus,
  TelemetryLogLevel,
  LatencyBreakdown,
  StageSpan,
  PersistedRecallExplainPayload,
  TelemetryEventInput,
  TelemetryEvent,
  TelemetryQuery,
  TelemetryQueryResult,
  TelemetryDatabaseConfig,
  TelemetryConfig,
  RecallExplanation,
  RecallExplainResult,
} from "./types.js";
export { WolbargLogger } from "./logger.js";
export {
  createSessionId,
  createTraceId,
  createRootTrace,
  createChildTrace,
} from "./trace.js";
export type { TraceContext } from "./trace.js";
export {
  TelemetryEmitter,
  NoopTelemetryProvider,
} from "./emitter.js";
export type {
  OperationTraceHandle,
  TelemetryEmitterContext,
} from "./emitter.js";
