/**
 * Portable memory database import / export helpers.
 * Interface is provider-agnostic; SQLite file+manifest is the first implementation.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConfigurationError, DatabaseError, ValidationError } from "../errors/index.js";
import { nowIso } from "../utils/index.js";
import { SDK_VERSION } from "../version.js";

let warnedMissingExportManifest = false;

export interface ExportManifest {
  format: "wolbarg-export-v1";
  exportedAt: string;
  sdkVersion: string;
  provider: string;
  sourcePath: string;
  organization?: string;
  /** Embedding provider model captured at export time. */
  embeddingModel?: string;
  /** Expected embedding vector dimensionality captured at export time. */
  embeddingDimensions?: number;
}

export interface MemoryExportResult {
  path: string;
  manifest: ExportManifest;
  sizeBytes: number;
}

export interface MemoryImportResult {
  path: string;
  manifest?: ExportManifest;
}

/**
 * Portable memory database import / export contract.
 *
 * Implement for S3, tarball, or remote backup targets. Built-in:
 * {@link SqliteMemoryTransferProvider} (file copy + manifest).
 */
export interface MemoryTransferProvider {
  exportTo(
    path: string,
    sourcePath: string,
    organization?: string,
    embeddingModel?: string,
    embeddingDimensions?: number,
  ): Promise<MemoryExportResult>;
  importFrom(
    path: string,
    targetPath: string,
    expected?: {
      organization?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
    },
  ): Promise<MemoryImportResult>;
}

/** SQLite file copy + JSON manifest export/import implementation. */
export class SqliteMemoryTransferProvider implements MemoryTransferProvider {
  async exportTo(
    exportPath: string,
    sourcePath: string,
    organization?: string,
    embeddingModel?: string,
    embeddingDimensions?: number,
  ): Promise<MemoryExportResult> {
    const resolvedSource = resolvePath(sourcePath);
    if (resolvedSource === ":memory:") {
      throw new ConfigurationError(
        "Cannot export an in-memory database. Use a file-backed SQLite database.",
      );
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new DatabaseError(
        `Failed to execute export()\nReason:\nSource database not found at ${resolvedSource}\nSuggestion:\nInitialize Wolbarg and verify the database path.`,
      );
    }

    const resolvedExport = resolvePath(exportPath);
    fs.mkdirSync(path.dirname(resolvedExport), { recursive: true });

    const dbExportPath = resolvedExport.endsWith(".db")
      ? resolvedExport
      : `${resolvedExport}.db`;
    const manifestPath = `${dbExportPath}.manifest.json`;

    await copySqlite(resolvedSource, dbExportPath);

    const manifest: ExportManifest = {
      format: "wolbarg-export-v1",
      exportedAt: nowIso(),
      sdkVersion: SDK_VERSION,
      provider: "sqlite",
      sourcePath: resolvedSource,
      organization,
      ...(embeddingModel ? { embeddingModel } : {}),
      ...(embeddingDimensions ? { embeddingDimensions } : {}),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
      path: dbExportPath,
      manifest,
      sizeBytes: fs.statSync(dbExportPath).size,
    };
  }

  async importFrom(
    exportPath: string,
    targetPath: string,
    expected?: {
      organization?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
    },
  ): Promise<MemoryImportResult> {
    const resolvedExport = resolvePath(exportPath);
    const dbExportPath = resolvedExport.endsWith(".db")
      ? resolvedExport
      : fs.existsSync(`${resolvedExport}.db`)
        ? `${resolvedExport}.db`
        : resolvedExport;

    if (!fs.existsSync(dbExportPath)) {
      throw new ValidationError(
        `Failed to execute import()\nReason:\nExport file not found at ${dbExportPath}\nSuggestion:\nPass the path returned by export().`,
      );
    }

    const manifestPath = `${dbExportPath}.manifest.json`;
    let manifest: ExportManifest | undefined;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExportManifest;
      if (manifest.format !== "wolbarg-export-v1") {
        throw new ValidationError(
          `Unsupported export format: ${String((manifest as { format?: string }).format)}`,
        );
      }
    } else {
      if (!warnedMissingExportManifest) {
        warnedMissingExportManifest = true;
        console.warn(
          "[wolbarg:warn] export manifest is missing; skipping manifest-based import validation.",
        );
      }
    }

    if (manifest) {
      if (
        expected?.organization &&
        manifest.organization &&
        expected.organization !== manifest.organization
      ) {
        throw new ValidationError(
          "Import failed: export organization does not match the current Wolbarg organization.",
        );
      }
      if (
        expected?.embeddingDimensions != null &&
        manifest.embeddingDimensions != null &&
        expected.embeddingDimensions !== manifest.embeddingDimensions
      ) {
        throw new ValidationError(
          `Import failed: embedding dimension mismatch (expected ${expected.embeddingDimensions}, got ${manifest.embeddingDimensions}).`,
        );
      }
      if (
        expected?.embeddingModel &&
        manifest.embeddingModel &&
        expected.embeddingModel !== manifest.embeddingModel
      ) {
        throw new ValidationError(
          `Import failed: embedding model mismatch (expected ${expected.embeddingModel}, got ${manifest.embeddingModel}).`,
        );
      }
    }

    const resolvedTarget = resolvePath(targetPath);
    if (resolvedTarget === ":memory:") {
      throw new ConfigurationError("Cannot import into an in-memory database.");
    }

    const tmpTarget = `${resolvedTarget}.tmp-import-${Date.now()}`;

    // Import into a temporary path first, then do an atomic swap. This keeps
    // the original database intact if the copy fails mid-way.
    for (const suffix of ["", "-wal", "-shm"]) {
      const side = `${tmpTarget}${suffix}`;
      if (fs.existsSync(side)) {
        fs.rmSync(side, { force: true });
      }
    }

    await copySqlite(dbExportPath, tmpTarget);

    // Swap temp -> target (main file + WAL/SHM siblings).
    for (const suffix of ["", "-wal", "-shm"]) {
      const side = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(side)) {
        fs.rmSync(side, { force: true });
      }
    }

    fs.renameSync(tmpTarget, resolvedTarget);
    for (const suffix of ["-wal", "-shm"]) {
      const from = `${tmpTarget}${suffix}`;
      const to = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }

    return { path: resolvedTarget, manifest: manifest ?? undefined };
  }
}

async function copySqlite(sourcePath: string, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let source: DatabaseSync | null = null;
  let dest: DatabaseSync | null = null;
  try {
    source = new DatabaseSync(sourcePath);
    try {
      source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore
    }
    dest = new DatabaseSync(destPath);
    const backupFn = (
      source as unknown as {
        backup?: (target: DatabaseSync) => void | Promise<void>;
      }
    ).backup;
    if (typeof backupFn === "function") {
      await backupFn.call(source, dest);
    } else {
      source.close();
      source = null;
      dest.close();
      dest = null;
      fs.copyFileSync(sourcePath, destPath);
    }
  } catch (error) {
    throw new DatabaseError(
      `SQLite transfer failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  } finally {
    try {
      source?.close();
    } catch {
      // ignore
    }
    try {
      dest?.close();
    } catch {
      // ignore
    }
  }
}

function resolvePath(p: string): string {
  if (p === ":memory:") return ":memory:";
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}
