/**
 * Shared Neo4j driver mock that understands Cypher emitted by Neo4jGraphProvider.
 */

export function createMockNeo4jModule() {
  type MockNode = { id: string; props: Record<string, unknown> };
  type MockRel = {
    from: string;
    to: string;
    type: string;
    props: Record<string, unknown>;
  };

  const memories = new Map<string, MockNode>();
  const entities = new Map<string, MockNode>();
  const related: MockRel[] = [];
  const mentions: MockRel[] = [];

  function ensureMemory(id: string) {
    if (!memories.has(id)) {
      memories.set(id, {
        id,
        props: {
          id,
          organization: "",
          agent: "",
          content_text: "",
          metadata_json: "{}",
          archived: false,
          compressed_into: "",
          created_at: "",
          updated_at: "",
        },
      });
    }
  }

  function memoryRow(id: string) {
    const n = memories.get(id)!;
    return { ...n.props };
  }

  function run(cypher: string, params: Record<string, unknown> = {}) {
    const c = cypher.replace(/\s+/g, " ").trim();

    if (c.startsWith("CREATE CONSTRAINT")) return { records: [] };

    if (c.includes("MERGE (m:Memory { id: $id })")) {
      ensureMemory(String(params.id));
      return { records: [] };
    }

    if (c.includes("MERGE (a)-[r:RELATED { relation: $relation }]->(b)")) {
      ensureMemory(String(params.fromId));
      ensureMemory(String(params.toId));
      for (let i = related.length - 1; i >= 0; i -= 1) {
        if (
          related[i]!.from === params.fromId &&
          related[i]!.to === params.toId &&
          related[i]!.props.relation === params.relation
        ) {
          related.splice(i, 1);
        }
      }
      related.push({
        from: String(params.fromId),
        to: String(params.toId),
        type: "RELATED",
        props: {
          relation: params.relation,
          metadata_json: params.metadata,
        },
      });
      return { records: [] };
    }

    if (c.includes("DELETE r") && c.includes("RELATED")) {
      for (let i = related.length - 1; i >= 0; i -= 1) {
        const r = related[i]!;
        if (r.from !== params.fromId || r.to !== params.toId) continue;
        if (
          params.relation !== undefined &&
          r.props.relation !== params.relation
        ) {
          continue;
        }
        related.splice(i, 1);
      }
      return { records: [] };
    }

    if (c.includes("DETACH DELETE m")) {
      const id = String(params.id);
      for (let i = related.length - 1; i >= 0; i -= 1) {
        if (related[i]!.from === id || related[i]!.to === id) {
          related.splice(i, 1);
        }
      }
      for (let i = mentions.length - 1; i >= 0; i -= 1) {
        if (mentions[i]!.to === id) mentions.splice(i, 1);
      }
      memories.delete(id);
      return { records: [] };
    }

    if (c.includes("MERGE (e:Entity { id: $id })")) {
      entities.set(String(params.id), {
        id: String(params.id),
        props: {
          id: params.id,
          name: params.name,
          type: params.type,
          metadata_json: params.metadata,
        },
      });
      return { records: [] };
    }

    if (c.includes("MATCH (e:Entity { id: $id }) RETURN e.id AS id")) {
      const e = entities.get(String(params.id));
      return {
        records: e
          ? [
              {
                keys: ["id"],
                get: (k: string) => (k === "id" ? e.id : undefined),
                toObject: () => ({ id: e.id }),
              },
            ]
          : [],
      };
    }

    if (c.includes("MERGE (e)-[r:MENTIONS]->(m)")) {
      mentions.push({
        from: String(params.entityId),
        to: String(params.memoryId),
        type: "MENTIONS",
        props: { role: params.role },
      });
      return { records: [] };
    }

    if (
      c.includes("MATCH (start:Memory { id: $id })") &&
      c.includes("RETURN DISTINCT")
    ) {
      const start = String(params.id);
      const depthMatch = c.match(/RELATED\*1\.\.(\d+)/);
      const depth = depthMatch ? Number(depthMatch[1]) : 1;
      const dirIn = c.includes("<-[:RELATED*");
      const dirOut = c.includes("]->(n:Memory)");
      const both = c.includes("]-(n:Memory)") && !dirOut && !dirIn;
      const relationFilter =
        typeof params.relation === "string" ? params.relation : undefined;

      const visited = new Set<string>([start]);
      let frontier = new Set<string>([start]);
      const found = new Set<string>();

      for (let d = 0; d < depth; d += 1) {
        const next = new Set<string>();
        for (const id of frontier) {
          for (const r of related) {
            if (relationFilter && r.props.relation !== relationFilter) continue;
            const candidates: string[] = [];
            if (dirOut || both) {
              if (r.from === id) candidates.push(r.to);
            }
            if (dirIn || both) {
              if (r.to === id) candidates.push(r.from);
            }
            for (const other of candidates) {
              if (visited.has(other)) continue;
              visited.add(other);
              next.add(other);
              found.add(other);
            }
          }
        }
        frontier = next;
        if (frontier.size === 0) break;
      }

      return {
        records: [...found].map((id) => {
          const row = memoryRow(id);
          return {
            keys: Object.keys(row),
            get: (k: string) => row[k],
            toObject: () => row,
          };
        }),
      };
    }

    // Generic RETURN for query() escape hatch / health
    if (c.includes("RETURN") && c.includes("count(")) {
      return {
        records: [
          {
            keys: ["c"],
            get: () => memories.size,
            toObject: () => ({ c: memories.size }),
          },
        ],
      };
    }

    return { records: [] };
  }

  return {
    auth: {
      basic: (username: string, password: string) => ({ username, password }),
    },
    driver: () => ({
      verifyConnectivity: async () => undefined,
      getServerInfo: async () => ({ mock: true }),
      close: async () => undefined,
      session: () => ({
        run: async (cypher: string, params?: Record<string, unknown>) =>
          run(cypher, params ?? {}),
        close: async () => undefined,
      }),
    }),
  };
}
