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

export class NoopTelemetryProvider implements TelemetryProvider {
  readonly name = "noop";

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  emit(_event: TelemetryEventInput): void {}
  async flush(): Promise<void> {}
}

export interface OperationTraceHandle {
  context: TraceContext;
  startedAt: number;
  latency: Partial<LatencyBreakdown>;
  child(operation: TelemetryOperation): OperationTraceHandle;
  mark(stage: keyof Omit<LatencyBreakdown, "totalMs">, ms: number): void;
  success(fields?: Partial<TelemetryEventInput>): void;
  failure(error: unknown, fields?: Partial<TelemetryEventInput>): void;
}

export interface TelemetryEmitterContext {
  organization?: string | null;
}

export class TelemetryEmitter {
  readonly sessionId: string;
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

  get enabled(): boolean {
    return this.config.enabled && this.provider.name !== "noop";
  }

  setProvider(provider: TelemetryProvider): void {
    this.provider = provider;
  }

  async open(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.provider.open();
  }

  async close(): Promise<void> {
    await this.provider.flush();
    await this.provider.close();
  }

  async flush(): Promise<void> {
    await this.provider.flush();
  }

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

  emitStartup(provider: string): void {
    const trace = this.start("startup");
    trace.success({ provider });
  }

  emitShutdown(provider: string): void {
    const trace = this.start("shutdown");
    trace.success({ provider });
  }
}
