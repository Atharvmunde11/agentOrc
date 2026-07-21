/**
 * Graph memory layer — provider contract + SQLite / Neo4j adapters.
 *
 * @packageDocumentation
 */

export type {
  GraphConfig,
  GraphDirection,
  GraphEntityInput,
  GraphHealthResult,
  GraphInput,
  GraphProvider,
  GetRelatedOptions,
} from "./types.js";

export {
  SqliteGraphProvider,
  DEFAULT_GET_RELATED_DEPTH,
} from "./providers/sqlite-graph.js";
export type { SqliteGraphProviderOptions } from "./providers/sqlite-graph.js";
export { Neo4jGraphProvider } from "./providers/neo4j.js";
export type { Neo4jGraphProviderOptions } from "./providers/neo4j.js";
export {
  cascadeDeleteMemoryNode,
  ENTITY_MENTIONS_RELATION,
} from "./sync/cascade.js";
