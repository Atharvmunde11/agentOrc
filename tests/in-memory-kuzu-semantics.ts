/**
 * In-memory GraphProvider that mirrors hop-BFS getRelated semantics used by
 * the typed graph contract (same outcomes as SqliteGraphProvider / Neo4j for
 * the portable suite). Test / CI stand-in only — not a production backend.
 */

import { DatabaseError } from "../src/errors/index.js";
import type { MemoryRecord } from "../src/types/index.js";
import {
  entityIdFrom,
  stubMemoryRecord,
} from "../src/graph/memory-node.js";
import type {
  GetRelatedOptions,
  GraphEntityInput,
  GraphHealthResult,
  GraphProvider,
} from "../src/graph/types.js";

type Rel = {
  from: string;
  to: string;
  relation: string;
  metadata?: Record<string, unknown>;
};

type Mention = { entityId: string; memoryId: string; role: string };

export class InMemorySemanticsGraph implements GraphProvider {
  readonly name = "in-memory"; // CI stand-in for the typed graph contract
  private memories = new Set<string>();
  private entities = new Map<string, GraphEntityInput & { id: string }>();
  private related: Rel[] = [];
  private mentions: Mention[] = [];
  private opened = false;

  supportsFileSnapshot(): boolean {
    return true;
  }

  getDataPath(): string | null {
    return null;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  private ensureOpen(): void {
    if (!this.opened) {
      throw new DatabaseError("graph not open");
    }
  }

  private ensureMemory(id: string): void {
    this.memories.add(id);
  }

  async linkMemories(
    fromId: string,
    toId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.ensureOpen();
    this.ensureMemory(fromId);
    this.ensureMemory(toId);
    this.related = this.related.filter(
      (r) => !(r.from === fromId && r.to === toId && r.relation === relation),
    );
    this.related.push({ from: fromId, to: toId, relation, metadata });
  }

  async unlinkMemories(
    fromId: string,
    toId: string,
    relation?: string,
  ): Promise<void> {
    this.ensureOpen();
    this.related = this.related.filter((r) => {
      if (r.from !== fromId || r.to !== toId) return true;
      if (relation !== undefined && r.relation !== relation) return true;
      return false;
    });
  }

  async getRelated(
    memoryId: string,
    options?: GetRelatedOptions,
  ): Promise<MemoryRecord[]> {
    this.ensureOpen();
    const depth = Math.max(1, Math.min(options?.depth ?? 1, 16));
    const direction = options?.direction ?? "both";
    const relation = options?.relation;

    const visited = new Set<string>([memoryId]);
    let frontier = new Set<string>([memoryId]);
    const found = new Map<string, MemoryRecord>();

    for (let d = 0; d < depth; d += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const r of this.related) {
          if (relation !== undefined && r.relation !== relation) continue;
          const candidates: string[] = [];
          if (direction === "out" || direction === "both") {
            if (r.from === id) candidates.push(r.to);
          }
          if (direction === "in" || direction === "both") {
            if (r.to === id) candidates.push(r.from);
          }
          for (const other of candidates) {
            if (visited.has(other)) continue;
            visited.add(other);
            next.add(other);
            found.set(other, stubMemoryRecord(other));
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    return [...found.values()];
  }

  async upsertEntity(entity: GraphEntityInput): Promise<string> {
    this.ensureOpen();
    const id = entityIdFrom(entity.name, entity.type);
    this.entities.set(id, { ...entity, id });
    return id;
  }

  async linkEntityToMemory(
    entityId: string,
    memoryId: string,
    role?: string,
  ): Promise<void> {
    this.ensureOpen();
    if (!this.entities.has(entityId)) {
      throw new DatabaseError(`Entity not found: ${entityId}`);
    }
    this.ensureMemory(memoryId);
    this.mentions = this.mentions.filter(
      (m) => !(m.entityId === entityId && m.memoryId === memoryId),
    );
    this.mentions.push({
      entityId,
      memoryId,
      role: role ?? "",
    });
  }

  async deleteMemory(memoryId: string): Promise<void> {
    this.ensureOpen();
    this.related = this.related.filter(
      (r) => r.from !== memoryId && r.to !== memoryId,
    );
    this.mentions = this.mentions.filter((m) => m.memoryId !== memoryId);
    this.memories.delete(memoryId);
  }

  async query(): Promise<unknown> {
    return [];
  }

  async health(): Promise<GraphHealthResult> {
    return {
      ok: this.opened,
      backend: "in-memory",
      details: { inMemoryStandIn: true },
    };
  }
}
