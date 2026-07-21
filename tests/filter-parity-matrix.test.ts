import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { matchesMetadata } from "../src/filters/match.js";
import { meta } from "../src/filters/types.js";
import { compileMetadataFilterToSql } from "../src/filters/sql-compile.js";
import type { MetadataFilter } from "../src/filters/types.js";

type Row = { id: string; metadata: any };

function createTempSqliteDb(): { dbPath: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolbarg-filter-parity-"));
  const dbPath = path.join(dir, "filter.db");
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL
    );
  `);
  return { dbPath, db };
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function selectIdsSql(db: DatabaseSync, filter: MetadataFilter): string[] | null {
  const compiled = compileMetadataFilterToSql(filter);
  if (!compiled) return null;
  const rows = db.prepare(
    `SELECT id FROM memories WHERE ${compiled.expression} ORDER BY id`,
  ).all(...(compiled.params as never[])) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

describe("filter parity matrix (match.ts vs SQLite)", () => {
  afterEach(() => {
    // no-op (each test creates its own sqlite file)
  });

  it("operators match JS semantics when evaluated through SQLite pushdown / fallback", () => {
    const { db, dbPath } = createTempSqliteDb();
    try {
      const rows: Row[] = [
        { id: "r1", metadata: { topic: "alpha", tags: ["alpha", "beta"], score: 0.5 } },
        { id: "r2", metadata: { topic: "beta", tags: ["alphabet"], score: 0.9 } },
        { id: "r3", metadata: { topic: null, tags: null, score: 0.1 } },
        { id: "r4", metadata: { topic: "alpha2", tags: ["zzz"], score: 0.65 } },
        { id: "r5", metadata: { topic: "ops", tags: ["alph"], score: 0.7 } },
      ];

      for (const r of rows) {
        db.prepare("INSERT INTO memories (id, metadata_json) VALUES (?, ?)").run(
          r.id,
          JSON.stringify(r.metadata),
        );
      }

      const cases: Array<{
        name: string;
        filter: MetadataFilter;
        expectedIds: string[];
      }> = [
        {
          name: "array contains",
          filter: meta.contains("tags", "alpha"),
          expectedIds: ["r1", "r2"],
        },
        {
          name: "string eq",
          filter: meta.eq("topic", "alpha"),
          expectedIds: ["r1"],
        },
        {
          name: "eq null falls back safely",
          filter: meta.eq("topic", null),
          expectedIds: ["r3"],
        },
        {
          name: "between (numeric)",
          filter: meta.between("score", 0.4, 0.7),
          expectedIds: ["r1", "r4", "r5"],
        },
        {
          name: "string compare (gt)",
          filter: meta.gt("topic", "alpha"),
          expectedIds: ["r2", "r4", "r5"],
        },
      ];

      for (const c of cases) {
        const jsIds = normalizeIds(
          rows.filter((r) => matchesMetadata(r.metadata, c.filter)).map((r) => r.id),
        );
        expect(jsIds).toEqual(c.expectedIds.sort());

        const sqlIds = selectIdsSql(db, c.filter);
        if (sqlIds === null) {
          // When SQLite pushdown is unsupported, Wolbarg's sqlite provider
          // falls back to JS matchesMetadata scanning. Here we mimic that.
          expect(sqlIds).toBeNull();
          // Specifically validate that eq null isn't safely pushdownable.
          if ("eq" in (c.filter as any).op && (c.filter as any).op.eq === null) {
            expect(compileMetadataFilterToSql(c.filter)).toBeNull();
          }
          expect(jsIds).toEqual(c.expectedIds.sort());
        } else {
          expect(normalizeIds(sqlIds)).toEqual(jsIds);
        }
      }
    } finally {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

