/**
 * Telemetry event types, latency breakdown, and query shapes.
 * Schema is intentionally extensible for future providers (Postgres, cloud).
 */

/** Public operation names recorded as telemetry events. */
export type TelemetryOperation =
  | "remember"
  | "update"
  | "recall"
  | "forget"
  | "compress"
  | "rememberBatch"
  | "recallBatch"
  | "export"
  | "import"
  | "checkpoint"
  | "rollback"
  | "error"
  | "startup"
  | "shutdown"
  | "ingest"
  | "history"
  | "stats"
  | "clear"
  | "deleteCheckpoint"
  | "listCheckpoints"
  | "getCheckpoint"
  | "linkMemories"
  | "getRelated"
  | "graphQuery"
  | "rememberFromMessages";

export type TelemetryStatus = "ok" | "error" | "cancelled";

export type TelemetryLogLevel =
  | "off"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";

/** Stage-level latency breakdown recorded on each event. */
export interface LatencyBreakdown {
  embeddingMs?: number;
  vectorSearchMs?: number;
  metadataFilteringMs?: number;
  rankingMs?: number;
  serializationMs?: number;
  databaseWriteMs?: number;
  databaseReadMs?: number;
  totalMs: number;
}

/** A measured stage within an operation, relative to the operation start. */
export interface StageSpan {
  name: keyof Omit<LatencyBreakdown, "totalMs"> | (string & {});
  startMs: number;
  durationMs: number;
}

/** Compact, JSON-safe recall explanation persisted with telemetry events. */
export interface PersistedRecallExplainPayload {
  enabled: true;
  providerUsed: string;
  rankingStrategy: string;
  signals: {
    semantic: "enabled";
    keyword: "enabled" | "disabled" | "unknown";
    reranker: "enabled" | "disabled" | "unknown";
    mmr: "enabled" | "disabled";
    recency: "disabled" | "unknown";
  };
  results: Array<{
    memoryId: string;
    score: number;
    distance: number;
    rankingReason: string;
    matchedFields: string[];
    metadataMatch: boolean;
  }>;
  searchTimeMs: number;
  rankingTimeMs: number;
  totalTimeMs: number;
}

/** Input accepted by TelemetryProvider.emit (id / timestamp may be filled). */
export interface TelemetryEventInput {
  id?: string;
  timestamp?: string;
  operation: TelemetryOperation;
  provider?: string | null;
  durationMs?: number | null;
  status: TelemetryStatus;
  query?: string | null;
  filters?: unknown;
  returnedCount?: number | null;
  memoryIds?: string[] | null;
  similarityScores?: number[] | null;
  metadata?: Record<string, unknown> | null;
  embeddingProvider?: string | null;
  model?: string | null;
  error?: string | null;
  errorStack?: string | null;
  sessionId: string;
  traceId: string;
  parentTraceId?: string | null;
  organization?: string | null;
  agentId?: string | null;
  tags?: string[] | null;
  checkpointId?: string | null;
  userMetadata?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
  latency?: LatencyBreakdown | null;
  explain?: PersistedRecallExplainPayload | null;
  spans?: StageSpan[] | null;
}

/** Fully persisted telemetry event row. */
export interface TelemetryEvent extends Required<
  Pick<
    TelemetryEventInput,
    | "id"
    | "timestamp"
    | "operation"
    | "status"
    | "sessionId"
    | "traceId"
  >
> {
  provider: string | null;
  durationMs: number | null;
  query: string | null;
  filters: unknown;
  returnedCount: number | null;
  memoryIds: string[] | null;
  similarityScores: number[] | null;
  metadata: Record<string, unknown> | null;
  embeddingProvider: string | null;
  model: string | null;
  error: string | null;
  errorStack: string | null;
  parentTraceId: string | null;
  organization: string | null;
  agentId: string | null;
  tags: string[] | null;
  checkpointId: string | null;
  userMetadata: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
  latency: LatencyBreakdown | null;
  explain: PersistedRecallExplainPayload | null;
  spans: StageSpan[] | null;
}

export interface TelemetryQuery {
  operation?: TelemetryOperation | TelemetryOperation[];
  status?: TelemetryStatus;
  traceId?: string;
  sessionId?: string;
  organization?: string;
  agentId?: string;
  tag?: string;
  checkpointId?: string;
  memoryId?: string;
  queryText?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  sortBy?: "timestamp" | "duration_ms";
  sortDir?: "asc" | "desc";
}

export interface TelemetryQueryResult {
  events: TelemetryEvent[];
  total: number;
  limit: number;
  offset: number;
}

/** Database config for the independent telemetry EventDatabase. */
export interface TelemetryDatabaseConfig {
  provider: "sqlite" | "postgres";
  /** Preferred v0.3 field. */
  url?: string;
  /** Back-compat alias for url. */
  connectionString?: string;
}

export interface TelemetryConfig {
  enabled?: boolean;
  database: TelemetryDatabaseConfig;
  level?: TelemetryLogLevel;
  captureQueries?: boolean;
  captureLatency?: boolean;
  captureErrors?: boolean;
  captureSimilarity?: boolean;
  captureEmbeddings?: boolean;
}

/** Enriched recall hit returned when `explain: true`. */
export interface RecallExplanation {
  memory: import("../types/index.js").RecallResult;
  score: number;
  distance: number;
  rankingReason: string;
  matchedFields: string[];
  metadataMatch: boolean;
  providerUsed: string;
  searchTimeMs: number;
  rankingTimeMs: number;
}

export interface RecallExplainResult {
  results: RecallExplanation[];
  providerUsed: string;
  searchTimeMs: number;
  rankingTimeMs: number;
  totalTimeMs: number;
  traceId: string;
}
