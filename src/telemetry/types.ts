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

/** Outcome recorded on each telemetry event. */
export type TelemetryStatus = "ok" | "error" | "cancelled";

/** Minimum log level for {@link WolbargLogger} and telemetry console output. */
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

/** Filter and pagination options for querying persisted telemetry events. */
export interface TelemetryQuery {
  /** Filter by one or more operation names. */
  operation?: TelemetryOperation | TelemetryOperation[];
  /** Filter by completion status. */
  status?: TelemetryStatus;
  /** Match events whose trace or parent trace equals this id. */
  traceId?: string;
  /** Filter by Wolbarg instance session id. */
  sessionId?: string;
  /** Filter by organization namespace. */
  organization?: string;
  /** Filter by agent id recorded on the event. */
  agentId?: string;
  /** Require a tag in the event's `tags` array. */
  tag?: string;
  /** Filter by checkpoint id when the operation touched checkpoints. */
  checkpointId?: string;
  /** Require the memory id in the event's `memoryIds` list. */
  memoryId?: string;
  /** Case-sensitive substring match on the recorded query text. */
  queryText?: string;
  /** ISO-8601 lower bound (inclusive). */
  since?: string;
  /** ISO-8601 upper bound (inclusive). */
  until?: string;
  /** Page size (default 50). */
  limit?: number;
  /** Page offset (default 0). */
  offset?: number;
  /** Sort column. */
  sortBy?: "timestamp" | "duration_ms";
  /** Sort direction. */
  sortDir?: "asc" | "desc";
}

/** Paginated telemetry query result. */
export interface TelemetryQueryResult {
  /** Matching events for the current page. */
  events: TelemetryEvent[];
  /** Total rows matching filters (ignoring limit/offset). */
  total: number;
  /** Applied page size. */
  limit: number;
  /** Applied page offset. */
  offset: number;
}

/** Database config for the independent telemetry EventDatabase. */
export interface TelemetryDatabaseConfig {
  /** Storage engine for telemetry (SQLite today; Postgres planned). */
  provider: "sqlite" | "postgres";
  /** Preferred v0.3 field — filesystem path or Postgres URL. */
  url?: string;
  /** Back-compat alias for {@link TelemetryDatabaseConfig.url}. */
  connectionString?: string;
}

/** Wolbarg constructor `telemetry` option — independent observability database. */
export interface TelemetryConfig {
  /** Master switch (default `true` when a provider is configured). */
  enabled?: boolean;
  /** Separate SQLite (or future Postgres) database for event storage. */
  database: TelemetryDatabaseConfig;
  /** Console log level for {@link WolbargLogger}. */
  level?: TelemetryLogLevel;
  /** Persist recall/remember query strings on events. */
  captureQueries?: boolean;
  /** Persist {@link LatencyBreakdown} and stage spans. */
  captureLatency?: boolean;
  /** Persist error message and stack on failed operations. */
  captureErrors?: boolean;
  /** Persist per-hit similarity scores on recall events. */
  captureSimilarity?: boolean;
  /** Persist raw embedding vectors (off by default — large payloads). */
  captureEmbeddings?: boolean;
}

/** Enriched recall hit returned when `explain: true`. */
export interface RecallExplanation {
  /** Recalled memory record. */
  memory: import("../types/index.js").RecallResult;
  /** Final ranking score after hybrid / rerank / MMR. */
  score: number;
  /** Vector cosine distance from the query embedding. */
  distance: number;
  /** Human-readable reason this hit ranked where it did. */
  rankingReason: string;
  /** Metadata / content fields that matched filters or keyword signals. */
  matchedFields: string[];
  /** Whether structured metadata filters matched. */
  metadataMatch: boolean;
  /** Storage backend that served the hit. */
  providerUsed: string;
  /** Vector / keyword retrieval time for this hit's batch (ms). */
  searchTimeMs: number;
  /** Rerank / MMR time attributable to this hit's batch (ms). */
  rankingTimeMs: number;
}

/** Full explain payload returned from {@link Wolbarg.recall} when `explain: true`. */
export interface RecallExplainResult {
  /** Per-hit ranking breakdowns. */
  results: RecallExplanation[];
  /** Storage / retrieval backend used for the search. */
  providerUsed: string;
  /** Vector / keyword search wall time in milliseconds. */
  searchTimeMs: number;
  /** Rerank / MMR / hybrid ranking time in milliseconds. */
  rankingTimeMs: number;
  /** End-to-end recall time in milliseconds. */
  totalTimeMs: number;
  /** Telemetry trace id for correlating with Studio. */
  traceId: string;
}
