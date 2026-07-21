/**
 * Neo4j graph provider (networked, production).
 *
 * Uses neo4j-driver session.run with parameterized Cypher for typed methods —
 * NOT GraphProvider.query(). Schema-flexible: nodes/relationships are created
 * freely without DDL.
 *
 * Install as optional peer: `npm install neo4j-driver`.
 */

import { ConfigurationError, DatabaseError } from "../../errors/index.js";
import type { MemoryRecord } from "../../types/index.js";
import {
  entityIdFrom,
  rowToMemoryRecord,
  serializeMetadata,
} from "../memory-node.js";
import type {
  GetRelatedOptions,
  GraphEntityInput,
  GraphHealthResult,
  GraphProvider,
} from "../types.js";

type Neo4jRecord = {
  get: (key: string) => unknown;
  keys: string[];
  toObject: () => Record<string, unknown>;
};

type Neo4jResult = {
  records: Neo4jRecord[];
};

type Neo4jSession = {
  run: (
    cypher: string,
    params?: Record<string, unknown>,
  ) => Promise<Neo4jResult>;
  close: () => Promise<void>;
};

type Neo4jDriver = {
  session: (options?: { database?: string }) => Neo4jSession;
  verifyConnectivity: () => Promise<void>;
  close: () => Promise<void>;
  getServerInfo?: () => Promise<unknown>;
};

type Neo4jModule = {
  driver: (
    url: string,
    auth: { username: string; password: string } | unknown,
    options?: Record<string, unknown>,
  ) => Neo4jDriver;
  auth: {
    basic: (username: string, password: string) => unknown;
  };
};

export interface Neo4jGraphProviderOptions {
  url: string;
  username: string;
  password: string;
  database?: string;
}

export class Neo4jGraphProvider implements GraphProvider {
  readonly name = "neo4j";
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;
  private readonly database: string | undefined;
  private driver: Neo4jDriver | null = null;
  private opened = false;

  constructor(options: Neo4jGraphProviderOptions) {
    if (!options?.url?.trim()) {
      throw new ConfigurationError("neo4j graph requires a non-empty url");
    }
    if (!options?.username?.trim()) {
      throw new ConfigurationError("neo4j graph requires a non-empty username");
    }
    if (typeof options.password !== "string") {
      throw new ConfigurationError("neo4j graph requires a password string");
    }
    this.url = options.url.trim();
    this.username = options.username.trim();
    this.password = options.password;
    this.database = options.database?.trim() || undefined;
  }

  supportsFileSnapshot(): boolean {
    return false;
  }

  getDataPath(): string | null {
    return null;
  }

  async open(): Promise<void> {
    if (this.opened) return;

    let mod: Neo4jModule;
    try {
      mod = (await import("neo4j-driver")) as unknown as Neo4jModule;
    } catch {
      throw new ConfigurationError(
        'Neo4j graph requires the optional "neo4j-driver" package. Install it with: npm install neo4j-driver',
      );
    }

    this.driver = mod.driver(
      this.url,
      mod.auth.basic(this.username, this.password),
    );
    await this.driver.verifyConnectivity();
    this.opened = true;
    // Ensure uniqueness constraints (best-effort; Neo4j is schema-flexible).
    await this.withSession(async (session) => {
      try {
        await session.run(
          `CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE`,
        );
      } catch {
        /* older Neo4j / community editions may lack IF NOT EXISTS */
      }
      try {
        await session.run(
          `CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE`,
        );
      } catch {
        /* ignore */
      }
    });
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
    }
    this.driver = null;
    this.opened = false;
  }

  private requireDriver(): Neo4jDriver {
    if (!this.driver || !this.opened) {
      throw new DatabaseError("Neo4j graph is not open", {
        operation: "graph",
        suggestion: "Call ready() / open() before graph operations",
      });
    }
    return this.driver;
  }

  private async withSession<T>(fn: (session: Neo4jSession) => Promise<T>): Promise<T> {
    const driver = this.requireDriver();
    const session = this.database
      ? driver.session({ database: this.database })
      : driver.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private async run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    return this.withSession((session) =>
      this.runOnSession(session, cypher, params),
    );
  }

  private async runOnSession(
    session: Neo4jSession,
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const result = await session.run(cypher, params);
    return result.records.map((rec) => {
      try {
        return rec.toObject();
      } catch {
        const obj: Record<string, unknown> = {};
        for (const key of rec.keys) {
          obj[key] = unwrapNeo4jValue(rec.get(key));
        }
        return obj;
      }
    });
  }

  private async ensureMemoryNode(
    id: string,
    session?: Neo4jSession,
  ): Promise<void> {
    const cypher = `MERGE (m:Memory { id: $id })
       ON CREATE SET
         m.organization = '',
         m.agent = '',
         m.content_text = '',
         m.metadata_json = '{}',
         m.archived = false,
         m.compressed_into = '',
         m.created_at = '',
         m.updated_at = ''`;

    if (session) {
      await this.runOnSession(session, cypher, { id });
      return;
    }
    await this.run(cypher, { id });
  }

  async linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Single session for the whole typed write (avoid 3 separate sessions).
    await this.withSession(async (session) => {
      await this.ensureMemoryNode(fromId, session);
      await this.ensureMemoryNode(toId, session);
      await this.runOnSession(
        session,
        `MATCH (a:Memory { id: $fromId }), (b:Memory { id: $toId })
         MERGE (a)-[r:RELATED { relation: $relation }]->(b)
         SET r.metadata_json = $metadata`,
        {
          fromId,
          toId,
          relation,
          metadata: serializeMetadata(metadata),
        },
      );
    });
  }

  async unlinkMemories(
    fromId: string,
    toId: string,
    relation?: string,
  ): Promise<void> {
    if (relation !== undefined) {
      await this.run(
        `MATCH (a:Memory { id: $fromId })-[r:RELATED { relation: $relation }]->(b:Memory { id: $toId })
         DELETE r`,
        { fromId, toId, relation },
      );
      return;
    }
    await this.run(
      `MATCH (a:Memory { id: $fromId })-[r:RELATED]->(b:Memory { id: $toId })
       DELETE r`,
      { fromId, toId },
    );
  }

  /**
   * Native Neo4j variable-length path traversal.
   * Relationship filter uses RELATED.relation property for parity with Kuzu.
   */
  async getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]> {
    const depth = Math.max(1, Math.min(options?.depth ?? 1, 16));
    const direction = options?.direction ?? "both";
    const relation = options?.relation;

    // Build direction-specific pattern. Depth is inlined (integer) — Neo4j
    // does not allow parameters inside [*1..n] in all versions.
    const pathPattern =
      direction === "out"
        ? `(start)-[:RELATED*1..${depth}]->(n:Memory)`
        : direction === "in"
          ? `(start)<-[:RELATED*1..${depth}]-(n:Memory)`
          : `(start)-[:RELATED*1..${depth}]-(n:Memory)`;

    const cypher = relation
      ? `MATCH (start:Memory { id: $id }), p = ${pathPattern}
         WHERE ALL(r IN relationships(p) WHERE r.relation = $relation)
           AND n.id <> $id
         RETURN DISTINCT
           n.id AS id, n.organization AS organization, n.agent AS agent,
           n.content_text AS content_text, n.metadata_json AS metadata_json,
           n.archived AS archived, n.compressed_into AS compressed_into,
           n.created_at AS created_at, n.updated_at AS updated_at`
      : `MATCH (start:Memory { id: $id }), p = ${pathPattern}
         WHERE n.id <> $id
         RETURN DISTINCT
           n.id AS id, n.organization AS organization, n.agent AS agent,
           n.content_text AS content_text, n.metadata_json AS metadata_json,
           n.archived AS archived, n.compressed_into AS compressed_into,
           n.created_at AS created_at, n.updated_at AS updated_at`;

    const params: Record<string, unknown> = { id: memoryId };
    if (relation !== undefined) params.relation = relation;

    const rows = await this.run(cypher, params);
    return rows.map((row) =>
      rowToMemoryRecord(unwrapRow(row)),
    );
  }

  async upsertEntity(entity: GraphEntityInput): Promise<string> {
    const id = entityIdFrom(entity.name, entity.type);
    await this.run(
      `MERGE (e:Entity { id: $id })
       SET e.name = $name, e.type = $type, e.metadata_json = $metadata`,
      {
        id,
        name: entity.name,
        type: entity.type,
        metadata: serializeMetadata(entity.metadata),
      },
    );
    return id;
  }

  async linkEntityToMemory(
    entityId: string,
    memoryId: string,
    role?: string,
  ): Promise<void> {
    // Single session for the whole typed write (avoid 3 separate sessions).
    await this.withSession(async (session) => {
      await this.ensureMemoryNode(memoryId, session);
      const found = await this.runOnSession(
        session,
        `MATCH (e:Entity { id: $id }) RETURN e.id AS id`,
        { id: entityId },
      );
      if (found.length === 0) {
        throw new DatabaseError(`Entity not found: ${entityId}`, {
          operation: "linkEntityToMemory",
        });
      }
      await this.runOnSession(
        session,
        `MATCH (e:Entity { id: $entityId }), (m:Memory { id: $memoryId })
         MERGE (e)-[r:MENTIONS]->(m)
         SET r.role = $role`,
        { entityId, memoryId, role: role ?? "" },
      );
    });
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.run(
      `MATCH (m:Memory { id: $id })
       DETACH DELETE m`,
      { id: memoryId },
    );
  }

  async query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.run(cypher, params ?? {});
  }

  async health(): Promise<GraphHealthResult> {
    try {
      if (!this.opened || !this.driver) {
        return { ok: false, backend: "neo4j", details: { reason: "not open" } };
      }
      await this.driver.verifyConnectivity();
      let serverInfo: unknown = undefined;
      if (typeof this.driver.getServerInfo === "function") {
        serverInfo = await this.driver.getServerInfo();
      }
      return {
        ok: true,
        backend: "neo4j",
        details: {
          url: this.url,
          database: this.database ?? "default",
          networked: true,
          serverInfo,
        },
      };
    } catch (error) {
      return {
        ok: false,
        backend: "neo4j",
        details: {
          url: this.url,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function unwrapNeo4jValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    try {
      return (value as { toNumber: () => number }).toNumber();
    } catch {
      /* Integer overflow — keep as-is */
    }
  }
  if (typeof value === "object" && value !== null && "properties" in value) {
    return unwrapRow(
      (value as { properties: Record<string, unknown> }).properties,
    );
  }
  return value;
}

function unwrapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = unwrapNeo4jValue(v);
  }
  return out;
}
