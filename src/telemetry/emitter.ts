/**
 * Async telemetry emitter that never blocks memory operations.
 */

import type { TelemetryProvider } from "../providers/interfaces/TelemetryProvider.js";
import type {
  LatencyBreakdown,
  StageSpan,
  TelemetryConfig,
  TelemetryEventInput,
  TelemetryOperation,
  TelemetryStatus,
} from "./types.js";
import { WolbargLogger } from "./logger.js";
import {
  createChildTrace,
  createRootTrace,
  createSessionId,
  type TraceContext,
} from "./trace.js";
import { createId, nowIso } from "../utils/index.js";

/** No-op telemetry provider used when observability is disabled. */
export class NoopTelemetryProvider implements TelemetryProvider {
  readonly name = "noop";

  /** @inheritdoc TelemetryProvider.open */
  async open(): Promise<void> {}
  /** @inheritdoc TelemetryProvider.close */
  async close(): Promise<void> {}
  /** @inheritdoc TelemetryProvider.emit */
  emit(_event: TelemetryEventInput): void {}
  /** @inheritdoc TelemetryProvider.flush */
  async flush(): Promise<void> {}
}

/**
 * Handle for an in-flight traced operation.
 *
 * Created by {@link TelemetryEmitter.start}. Call `success()` or `failure()`
 * exactly once when the operation completes.
 */
export interface OperationTraceHandle {
  /** Distributed trace context (session, trace, parent ids). */
  context: TraceContext;
  /** `performance.now()` at operation start. */
  startedAt: number;
  /** Partial latency breakdown filled via {@link OperationTraceHandle.mark}. */
  latency: Partial<LatencyBreakdown>;
  /** Start a child trace for nested operations. */
  child(operation: TelemetryOperation): OperationTraceHandle;
  /** Record stage latency in milliseconds. */
  mark(stage: keyof Omit<LatencyBreakdown, "totalMs">, ms: number): void;
  /** Emit a successful completion event. */
  success(fields?: Partial<TelemetryEventInput>): void;
  /** Emit a failed completion event. */
  failure(error: unknown, fields?: Partial<TelemetryEventInput>): void;
}

/** Default organization injected into events when not overridden per-call. */
export interface TelemetryEmitterContext {
  /** Organization namespace from Wolbarg constructor. */
  organization?: string | null;
}

/**
 * Async telemetry emitter — never blocks memory operations.
 *
 * Wraps a {@link TelemetryProvider} with session/trace lifecycle helpers and
 * configurable capture flags (queries, latency, errors, similarity scores).
 */
export class TelemetryEmitter {
  /** Stable session id for this Wolbarg instance lifetime. */
  readonly sessionId: string;
  /** Structured logger gated by telemetry log level. */
  readonly logger: WolbargLogger;
  private provider: TelemetryProvider;
  private readonly config: Required<
    Pick<
      TelemetryConfig,
      | "enabled"
      | "level"
      | "captureQueries"
      | "captureLatency"
      | "captureErrors"
      | "captureSimilarity"
      | "captureEmbeddings"
    >
  >;
  private readonly context: TelemetryEmitterContext;

  /**
   * @param provider - Telemetry backend, or `null` for {@link NoopTelemetryProvider}.
   * @param config - Capture flags and log level.
   * @param context - Default organization injected into events.
   */
  constructor(
    provider: TelemetryProvider | null,
    config?: Partial<TelemetryConfig>,
    context: TelemetryEmitterContext = {},
  ) {
    this.sessionId = createSessionId();
    this.provider = provider ?? new NoopTelemetryProvider();
    this.config = {
      enabled: config?.enabled ?? Boolean(provider),
      level: config?.level ?? "info",
      captureQueries: config?.captureQueries ?? true,
      captureLatency: config?.captureLatency ?? true,
      captureErrors: config?.captureErrors ?? true,
      captureSimilarity: config?.captureSimilarity ?? true,
      captureEmbeddings: config?.captureEmbeddings ?? false,
    };
    this.context = context;
    this.logger = new WolbargLogger(this.config.level);
  }

  /** Whether telemetry is enabled and backed by a non-noop provider. */
  get enabled(): boolean {
    return this.config.enabled && this.provider.name !== "noop";
  }

  /** Replace the underlying telemetry provider (e.g. after lazy init). */
  setProvider(provider: TelemetryProvider): void {
    this.provider = provider;
  }

  /** Open the underlying telemetry provider when enabled. */
  async open(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.provider.open();
  }

  /** Flush pending events and close the telemetry provider. */
  async close(): Promise<void> {
    await this.provider.flush();
    await this.provider.close();
  }

  /** Flush pending telemetry events without closing the provider. */
  async flush(): Promise<void> {
    await this.provider.flush();
  }

  /**
   * Begin tracing an operation.
   *
   * @param operation - Public telemetry operation name.
   * @param parent - Optional parent trace for nested spans.
   * @returns Handle — call `success()` or `failure()` when done.
   */
  start(operation: TelemetryOperation, parent?: TraceContext): OperationTraceHandle {
    const context = parent
      ? createChildTrace(parent)
      : createRootTrace(this.sessionId);
    const startedAt = performance.now();
    const latency: Partial<LatencyBreakdown> = {};
    const spans: StageSpan[] = [];
    const self = this;

    const finish = (
      status: TelemetryStatus,
      fields?: Partial<TelemetryEventInput>,
      error?: unknown,
    ): void => {
      const totalMs = performance.now() - startedAt;
      const errMessage =
        error instanceof Error
          ? error.message
          : error
            ? String(error)
            : fields?.error ?? null;
      const errStack =
        error instanceof Error ? error.stack ?? null : fields?.errorStack ?? null;

      if (!self.config.enabled) {
        return;
      }

      if (status === "error") {
        self.logger.error(`${operation} failed: ${errMessage ?? "unknown"}`);
      } else {
        self.logger.debug(`${operation} completed in ${totalMs.toFixed(2)}ms`);
      }

      const event: TelemetryEventInput = {
        id: createId(),
        timestamp: nowIso(),
        operation,
        status,
        sessionId: context.sessionId,
        traceId: context.traceId,
        parentTraceId: context.parentTraceId,
        organization: fields?.organization ?? self.context.organization ?? null,
        agentId: fields?.agentId ?? null,
        tags: fields?.tags ?? null,
        checkpointId: fields?.checkpointId ?? null,
        durationMs: totalMs,
        provider: fields?.provider ?? null,
        query: self.config.captureQueries ? (fields?.query ?? null) : null,
        filters: fields?.filters ?? null,
        returnedCount: fields?.returnedCount ?? null,
        memoryIds: fields?.memoryIds ?? null,
        similarityScores: self.config.captureSimilarity
          ? (fields?.similarityScores ?? null)
          : null,
        metadata: fields?.metadata ?? null,
        embeddingProvider: fields?.embeddingProvider ?? null,
        model: fields?.model ?? null,
        error: self.config.captureErrors ? errMessage : null,
        errorStack: self.config.captureErrors ? errStack : null,
        userMetadata: fields?.userMetadata ?? null,
        extra: fields?.extra ?? null,
        latency: self.config.captureLatency
          ? { ...latency, totalMs, ...(fields?.latency ?? {}) }
          : { totalMs },
        explain: fields?.explain ?? null,
        spans: self.config.captureLatency
          ? [...spans, ...(fields?.spans ?? [])]
          : null,
      };

      // Never await — memory path must stay non-blocking.
      self.provider.emit(event);
    };

    return {
      context,
      startedAt,
      latency,
      child(childOp: TelemetryOperation): OperationTraceHandle {
        return self.start(childOp, context);
      },
      mark(stage, ms) {
        latency[stage] = ms;
        const elapsed = performance.now() - startedAt;
        spans.push({
          name: stage,
          startMs: Math.max(0, elapsed - ms),
          durationMs: ms,
        });
      },
      success(fields) {
        finish("ok", fields);
      },
      failure(error, fields) {
        finish("error", fields, error);
      },
    };
  }

  /** Emit a startup telemetry event. */
  emitStartup(provider: string): void {
    const trace = this.start("startup");
    trace.success({ provider });
  }

  /** Emit a shutdown telemetry event. */
  emitShutdown(provider: string): void {
    const trace = this.start("shutdown");
    trace.success({ provider });
  }
}
