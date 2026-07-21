/**
 * SQLite EventDatabase — completely separate from the memory database.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DatabaseError, InitializationError } from "../../errors/index.js";
import type { EventDatabase } from "../interfaces/EventDatabase.js";
import type {
  LatencyBreakdown,
  PersistedRecallExplainPayload,
  StageSpan,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryQuery,
  TelemetryQueryResult,
} from "../../telemetry/types.js";
import { createId, nowIso } from "../../utils/index.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT,
  duration_ms REAL,
  status TEXT NOT NULL,
  query TEXT,
  filters_json TEXT,
  returned_count INTEGER,
  memory_ids_json TEXT,
  similarity_scores_json TEXT,
  metadata_json TEXT,
  embedding_provider TEXT,
  model TEXT,
  error TEXT,
  error_stack TEXT,
  session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_trace_id TEXT,
  user_metadata_json TEXT,
  extra_json TEXT,
  latency_json TEXT,
  organization TEXT,
  agent_id TEXT,
  tags_json TEXT,
  checkpoint_id TEXT,
  explain_json TEXT,
  spans_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_operation ON telemetry_events(operation);
CREATE INDEX IF NOT EXISTS idx_telemetry_trace ON telemetry_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_status ON telemetry_events(status);
`;

const V2_COLUMNS = {
  organization: "TEXT",
  agent_id: "TEXT",
  tags_json: "TEXT",
  checkpoint_id: "TEXT",
  explain_json: "TEXT",
  spans_json: "TEXT",
} as const;

const V2_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON telemetry_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_org ON telemetry_events(organization);
CREATE INDEX IF NOT EXISTS idx_telemetry_checkpoint ON telemetry_events(checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_operation_time ON telemetry_events(operation, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_status_time ON telemetry_events(status, timestamp);
`;

export interface SqliteEventDatabaseOptions {
  url: string;
  /** When true, open read-only (Studio). */
  readonly?: boolean;
}

export class SqliteEventDatabase implements EventDatabase {
  readonly name = "sqlite";
  private readonly url: string;
  private readonly readonly: boolean;
  private db: DatabaseSync | null = null;
  private insertStmt: StatementSync | null = null;
  private columns = new Set<string>();

  /**
   * @param options.url - Path to the telemetry SQLite file.
   * @param options.readonly - Open read-only (Studio / analytics).
   */
  constructor(options: SqliteEventDatabaseOptions) {
    this.url = options.url;
    this.readonly = options.readonly ?? false;
  }

  /** Open the telemetry database and run schema migrations. */
  async open(): Promise<void> {
    try {
      const dbPath = this.resolvePath(this.url);
      if (dbPath !== ":memory:" && !this.readonly) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }

      const db = new DatabaseSync(dbPath, {
        allowExtension: false,
        readOnly: this.readonly,
      });
      this.db = db;

      if (!this.readonly) {
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec(`
          PRAGMA synchronous = NORMAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA temp_store = MEMORY;
        `);
        db.exec(SCHEMA_SQL);
        this.migrateToV2(db);
      }
      this.columns = readColumns(db);
      if (!this.readonly) {
        this.insertStmt = db.prepare(`
          INSERT INTO telemetry_events (
            id, timestamp, operation, provider, duration_ms, status,
            query, filters_json, returned_count, memory_ids_json,
            similarity_scores_json, metadata_json, embedding_provider, model,
            error, error_stack, session_id, trace_id, parent_trace_id,
            user_metadata_json, extra_json, latency_json, organization,
            agent_id, tags_json, checkpoint_id, explain_json, spans_json
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `);
      }
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        // ignore
      }
      this.db = null;
      this.columns.clear();
      throw new InitializationError(
        `Failed to open telemetry EventDatabase: ${describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  /** Close the telemetry database connection. */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      this.db.close();
    } finally {
      this.db = null;
      this.insertStmt = null;
      this.columns.clear();
    }
  }

  /** Insert one normalized telemetry event row. */
  async insertEvent(input: TelemetryEventInput): Promise<TelemetryEvent> {
    const event = normalizeEvent(input);
    const stmt = this.insertStmt;
    if (!stmt) {
      throw new DatabaseError("Telemetry EventDatabase is not open for writes");
    }
    try {
      stmt.run(
        event.id,
        event.timestamp,
        event.operation,
        event.provider,
        event.durationMs,
        event.status,
        event.query,
        jsonOrNull(event.filters),
        event.returnedCount,
        jsonOrNull(event.memoryIds),
        jsonOrNull(event.similarityScores),
        jsonOrNull(event.metadata),
        event.embeddingProvider,
        event.model,
        event.error,
        event.errorStack,
        event.sessionId,
        event.traceId,
        event.parentTraceId,
        jsonOrNull(event.userMetadata),
        jsonOrNull(event.extra),
        jsonOrNull(event.latency),
        event.organization,
        event.agentId,
        jsonOrNull(event.tags),
        event.checkpointId,
        jsonOrNull(event.explain),
        jsonOrNull(event.spans),
      );
      return event;
    } catch (error) {
      throw new DatabaseError(
        `Failed to write telemetry event: ${describe(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  /** Insert many events in a single transaction. */
  async insertEvents(inputs: TelemetryEventInput[]): Promise<TelemetryEvent[]> {
    const db = this.requireDb();
    const out: TelemetryEvent[] = [];
    db.exec("BEGIN");
    try {
      for (const input of inputs) {
        out.push(await this.insertEvent(input));
      }
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  /** Query telemetry events with filters, sort, and pagination. */
  async query(options: TelemetryQuery): Promise<TelemetryQueryResult> {
    const db = this.requireDb();
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.operation) {
      const ops = Array.isArray(options.operation)
        ? options.operation
        : [options.operation];
      clauses.push(`operation IN (${ops.map(() => "?").join(",")})`);
      params.push(...ops);
    }
    if (options.status) {
      clauses.push(`status = ?`);
      params.push(options.status);
    }
    if (options.traceId) {
      clauses.push(`(trace_id = ? OR parent_trace_id = ?)`);
      params.push(options.traceId, options.traceId);
    }
    if (options.sessionId) {
      clauses.push(`session_id = ?`);
      params.push(options.sessionId);
    }
    this.addOptionalColumnFilter(
      clauses,
      params,
      "organization",
      options.organization,
    );
    this.addOptionalColumnFilter(clauses, params, "agent_id", options.agentId);
    this.addOptionalColumnFilter(
      clauses,
      params,
      "checkpoint_id",
      options.checkpointId,
    );
    if (options.tag) {
      if (this.columns.has("tags_json")) {
        clauses.push(
          `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = ?)`,
        );
        params.push(options.tag);
      } else {
        clauses.push("0 = 1");
      }
    }
    if (options.memoryId) {
      // Exact membership match (avoid substring false-positives).
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(memory_ids_json) WHERE json_each.value = ?)`,
      );
      params.push(options.memoryId);
    }
    if (options.queryText) {
      clauses.push(`query LIKE ?`);
      params.push(`%${options.queryText}%`);
    }
    if (options.since) {
      clauses.push(`timestamp >= ?`);
      params.push(options.since);
    }
    if (options.until) {
      clauses.push(`timestamp <= ?`);
      params.push(options.until);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sortCol =
      options.sortBy === "duration_ms" ? "duration_ms" : "timestamp";
    const sortDir = options.sortDir === "asc" ? "ASC" : "DESC";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS c FROM telemetry_events ${where}`)
      .get(...params) as { c: number | bigint };
    const rows = db
      .prepare(
        `SELECT * FROM telemetry_events ${where}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as Row[];

    return {
      events: rows.map(rowToEvent),
      total: Number(totalRow.c),
      limit,
      offset,
    };
  }

  /** Fetch one event by primary key. */
  async getEvent(id: string): Promise<TelemetryEvent | null> {
    const db = this.requireDb();
    const row = db
      .prepare(`SELECT * FROM telemetry_events WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** Count events optionally filtered by time and operation. */
  async countEvents(filter?: {
    since?: string;
    operation?: string;
  }): Promise<number> {
    const db = this.requireDb();
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.since) {
      clauses.push(`timestamp >= ?`);
      params.push(filter.since);
    }
    if (filter?.operation) {
      clauses.push(`operation = ?`);
      params.push(filter.operation);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM telemetry_events ${where}`)
      .get(...params) as { c: number | bigint };
    return Number(row.c);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new DatabaseError("Telemetry EventDatabase is not open");
    }
    return this.db;
  }

  private migrateToV2(db: DatabaseSync): void {
    const columns = readColumns(db);
    for (const [name, type] of Object.entries(V2_COLUMNS)) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE telemetry_events ADD COLUMN ${name} ${type};`);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO telemetry_meta(key, value) VALUES ('schema_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      ${V2_INDEXES_SQL}
    `);
  }

  private addOptionalColumnFilter(
    clauses: string[],
    params: Array<string | number>,
    column: string,
    value: string | undefined,
  ): void {
    if (!value) return;
    if (!this.columns.has(column)) {
      clauses.push("0 = 1");
      return;
    }
    clauses.push(`${column} = ?`);
    params.push(value);
  }

  private resolvePath(url: string): string {
    if (url === ":memory:") return ":memory:";
    return path.isAbsolute(url) ? url : path.resolve(process.cwd(), url);
  }
}

interface Row {
  id: string;
  timestamp: string;
  operation: string;
  provider: string | null;
  duration_ms: number | null;
  status: string;
  query: string | null;
  filters_json: string | null;
  returned_count: number | null;
  memory_ids_json: string | null;
  similarity_scores_json: string | null;
  metadata_json: string | null;
  embedding_provider: string | null;
  model: string | null;
  error: string | null;
  error_stack: string | null;
  session_id: string;
  trace_id: string;
  parent_trace_id: string | null;
  user_metadata_json: string | null;
  extra_json: string | null;
  latency_json: string | null;
  organization?: string | null;
  agent_id?: string | null;
  tags_json?: string | null;
  checkpoint_id?: string | null;
  explain_json?: string | null;
  spans_json?: string | null;
}

function normalizeEvent(input: TelemetryEventInput): TelemetryEvent {
  return {
    id: input.id ?? createId(),
    timestamp: input.timestamp ?? nowIso(),
    operation: input.operation,
    provider: input.provider ?? null,
    durationMs: input.durationMs ?? null,
    status: input.status,
    query: input.query ?? null,
    filters: input.filters ?? null,
    returnedCount: input.returnedCount ?? null,
    memoryIds: input.memoryIds ?? null,
    similarityScores: input.similarityScores ?? null,
    metadata: input.metadata ?? null,
    embeddingProvider: input.embeddingProvider ?? null,
    model: input.model ?? null,
    error: input.error ?? null,
    errorStack: input.errorStack ?? null,
    sessionId: input.sessionId,
    traceId: input.traceId,
    parentTraceId: input.parentTraceId ?? null,
    organization: input.organization ?? null,
    agentId: input.agentId ?? null,
    tags: input.tags ?? null,
    checkpointId: input.checkpointId ?? null,
    userMetadata: input.userMetadata ?? null,
    extra: input.extra ?? null,
    latency: input.latency ?? null,
    explain: input.explain ?? null,
    spans: input.spans ?? null,
  };
}

function rowToEvent(row: Row): TelemetryEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    operation: row.operation as TelemetryEvent["operation"],
    provider: row.provider,
    durationMs: row.duration_ms,
    status: row.status as TelemetryEvent["status"],
    query: row.query,
    filters: parseJson(row.filters_json),
    returnedCount: row.returned_count,
    memoryIds: parseJson(row.memory_ids_json) as string[] | null,
    similarityScores: parseJson(row.similarity_scores_json) as number[] | null,
    metadata: parseJson(row.metadata_json) as Record<string, unknown> | null,
    embeddingProvider: row.embedding_provider,
    model: row.model,
    error: row.error,
    errorStack: row.error_stack,
    sessionId: row.session_id,
    traceId: row.trace_id,
    parentTraceId: row.parent_trace_id,
    organization: row.organization ?? null,
    agentId: row.agent_id ?? null,
    tags: parseJson(row.tags_json ?? null) as string[] | null,
    checkpointId: row.checkpoint_id ?? null,
    userMetadata: parseJson(row.user_metadata_json) as Record<
      string,
      unknown
    > | null,
    extra: parseJson(row.extra_json) as Record<string, unknown> | null,
    latency: parseJson(row.latency_json) as LatencyBreakdown | null,
    explain: parseJson(
      row.explain_json ?? null,
    ) as PersistedRecallExplainPayload | null,
    spans: parseJson(row.spans_json ?? null) as StageSpan[] | null,
  };
}

function readColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare("PRAGMA table_info(telemetry_events)").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
