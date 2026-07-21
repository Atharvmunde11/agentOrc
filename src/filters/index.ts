/**
 * Public metadata filter exports — AST builders, matchers, and SQL compilers.
 */
export type { MetadataComparison, MetadataFilter } from "./types.js";
export { meta } from "./types.js";
export { matchesMetadata } from "./match.js";
export {
  compileMetadataFilterToSql,
  type CompiledMetadataSql,
} from "./sql-compile.js";
export { compileMetadataFilterToPostgres } from "./sql-compile-postgres.js";
