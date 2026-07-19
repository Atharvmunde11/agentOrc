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

export interface ExportManifest {
  format: "wolbarg-export-v1";
  exportedAt: string;
  sdkVersion: string;
  provider: string;
  sourcePath: string;
  organization?: string;
}

export interface MemoryExportResult {
  path: string;
  manifest: ExportManifest;
  sizeBytes: number;
}

export interface MemoryImportResult {
  path: string;
  manifest: ExportManifest;
}

export interface MemoryTransferProvider {
  exportTo(path: string, sourcePath: string, organization?: string): Promise<MemoryExportResult>;
  importFrom(path: string, targetPath: string): Promise<MemoryImportResult>;
}

export class SqliteMemoryTransferProvider implements MemoryTransferProvider {
  async exportTo(
    exportPath: string,
    sourcePath: string,
    organization?: string,
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
    let manifest: ExportManifest;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExportManifest;
      if (manifest.format !== "wolbarg-export-v1") {
        throw new ValidationError(
          `Unsupported export format: ${String((manifest as { format?: string }).format)}`,
        );
      }
    } else {
      manifest = {
        format: "wolbarg-export-v1",
        exportedAt: nowIso(),
        sdkVersion: SDK_VERSION,
        provider: "sqlite",
        sourcePath: dbExportPath,
      };
    }

    const resolvedTarget = resolvePath(targetPath);
    if (resolvedTarget === ":memory:") {
      throw new ConfigurationError("Cannot import into an in-memory database.");
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const side = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(side)) {
        fs.rmSync(side, { force: true });
      }
    }
    await copySqlite(dbExportPath, resolvedTarget);

    return { path: resolvedTarget, manifest };
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
