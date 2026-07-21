/**
 * First-party SQLite checkpoint provider.
 * Creates immutable named snapshots of the memory database.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ConfigurationError,
  DatabaseError,
  ValidationError,
} from "../../errors/index.js";
import type {
  CheckpointMeta,
  CheckpointProvider,
  CreateCheckpointOptions,
} from "../interfaces/CheckpointProvider.js";
import { nowIso } from "../../utils/index.js";
import { SDK_VERSION } from "../../version.js";

export interface SqliteCheckpointProviderOptions {
  /** Directory that stores checkpoint snapshots + metadata. */
  directory?: string;
}

interface CheckpointRecord extends CheckpointMeta {
  // marker for JSON shape
}

export class SqliteCheckpointProvider implements CheckpointProvider {
  readonly name = "sqlite";
  private readonly directory: string;
  private ready = false;

  /**
   * @param options.directory - Folder for `.json` metadata and `.db` snapshot files.
   */
  constructor(options?: SqliteCheckpointProviderOptions) {
    this.directory =
      options?.directory ??
      path.resolve(process.cwd(), ".wolbarg", "checkpoints");
  }

  /** Ensure the checkpoint directory exists. */
  async open(): Promise<void> {
    fs.mkdirSync(this.directory, { recursive: true });
    this.ready = true;
  }

  /** Mark the provider closed (does not delete snapshots). */
  async close(): Promise<void> {
    this.ready = false;
  }

  /**
   * Create an immutable SQLite backup of `sourcePath` under a unique name.
   *
   * @param name - Checkpoint label (must not already exist).
   * @param sourcePath - Live memory database path to snapshot.
   * @param options.description - Optional human-readable description stored in metadata.
   */
  async checkpoint(
    name: string,
    sourcePath: string,
    options?: CreateCheckpointOptions,
  ): Promise<CheckpointMeta> {
    this.requireReady();
    assertCheckpointName(name);

    const metaPath = this.metaPath(name);
    if (fs.existsSync(metaPath)) {
      throw new ValidationError(
        `Checkpoint "${name}" already exists. Choose a different name — checkpoints are never overwritten.`,
      );
    }

    const resolvedSource = resolveDbPath(sourcePath);
    if (resolvedSource === ":memory:") {
      throw new ConfigurationError(
        "Cannot checkpoint an in-memory database. Use a file-backed SQLite database.",
      );
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new DatabaseError(
        `Failed to execute checkpoint()\nReason:\nMemory database not found at ${resolvedSource}\nSuggestion:\nEnsure Wolbarg has been initialized and the database path is correct.`,
      );
    }

    const snapshotPath = this.snapshotPath(name);
    const tmpSnapshotPath = `${snapshotPath}.tmp-${Date.now()}`;
    try {
      await safeSqliteBackup(resolvedSource, tmpSnapshotPath);
    } catch (error) {
      if (fs.existsSync(tmpSnapshotPath)) {
        fs.rmSync(tmpSnapshotPath, { force: true });
      }
      throw error;
    }

    const stats = fs.statSync(tmpSnapshotPath);
    if (fs.existsSync(snapshotPath)) {
      fs.rmSync(snapshotPath, { force: true });
    }
    fs.renameSync(tmpSnapshotPath, snapshotPath);
    const meta: CheckpointRecord = {
      name,
      description: options?.description ?? null,
      createdAt: nowIso(),
      sdkVersion: SDK_VERSION,
      provider: this.name,
      snapshotPath,
      sourcePath: resolvedSource,
      sizeBytes: stats.size,
    };

    const tmpMetaPath = `${metaPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpMetaPath, JSON.stringify(meta, null, 2), "utf8");
    fs.renameSync(tmpMetaPath, metaPath);
    return meta;
  }

  /**
   * Restore a named checkpoint over `targetPath` (replaces WAL/SHM side files).
   *
   * @param name - Existing checkpoint name.
   * @param targetPath - Live memory database path to overwrite.
   */
  async rollback(name: string, targetPath: string): Promise<CheckpointMeta> {
    this.requireReady();
    const meta = await this.getCheckpoint(name);
    if (!meta) {
      throw new ValidationError(`Checkpoint "${name}" was not found`);
    }
    const resolvedTarget = resolveDbPath(targetPath);
    if (resolvedTarget === ":memory:") {
      throw new ConfigurationError(
        "Cannot rollback into an in-memory database.",
      );
    }

    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    // Remove WAL/SHM so the restored main file is authoritative.
    for (const suffix of ["", "-wal", "-shm"]) {
      const side = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(side)) {
        fs.rmSync(side, { force: true });
      }
    }
    await safeSqliteBackup(meta.snapshotPath, resolvedTarget);
    return meta;
  }

  /** Delete checkpoint metadata and snapshot files for `name`. */
  async deleteCheckpoint(name: string): Promise<boolean> {
    this.requireReady();
    const metaPath = this.metaPath(name);
    const snapshotPath = this.snapshotPath(name);
    let removed = false;
    if (fs.existsSync(metaPath)) {
      fs.rmSync(metaPath, { force: true });
      removed = true;
    }
    if (fs.existsSync(snapshotPath)) {
      fs.rmSync(snapshotPath, { force: true });
      removed = true;
    }
    return removed;
  }

  /** List all checkpoints sorted by creation time. */
  async listCheckpoints(): Promise<CheckpointMeta[]> {
    this.requireReady();
    if (!fs.existsSync(this.directory)) {
      return [];
    }
    const files = fs
      .readdirSync(this.directory)
      .filter((f) => f.endsWith(".json"));
    const out: CheckpointMeta[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.directory, file), "utf8");
        out.push(JSON.parse(raw) as CheckpointMeta);
      } catch {
        // skip corrupt metadata
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Load checkpoint metadata by name, or `null` if missing / corrupt. */
  async getCheckpoint(name: string): Promise<CheckpointMeta | null> {
    this.requireReady();
    const metaPath = this.metaPath(name);
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8")) as CheckpointMeta;
    } catch {
      return null;
    }
  }

  /**
   * Consistent SQLite file backup (WAL checkpoint + backup API / copy).
   * Used for memory snapshots and for secondary files such as the graph DB.
   */
  async backupSqliteFile(sourcePath: string, destPath: string): Promise<void> {
    this.requireReady();
    const resolved = resolveDbPath(sourcePath);
    if (resolved === ":memory:") {
      throw new ConfigurationError(
        "Cannot backup an in-memory database. Use a file-backed SQLite database.",
      );
    }
    if (!fs.existsSync(resolved)) {
      throw new DatabaseError(
        `SQLite file not found at ${resolved}`,
        {
          suggestion: "Ensure the source database exists before backing up.",
        },
      );
    }
    await safeSqliteBackup(resolved, destPath);
  }

  /**
   * Snapshot a secondary SQLite file (typically the graph DB) next to a named
   * memory checkpoint as `{name}.graph.db`.
   */
  async checkpointGraph(
    name: string,
    graphSourcePath: string,
  ): Promise<string> {
    this.requireReady();
    assertCheckpointName(name);
    const dest = this.graphSnapshotPath(name);
    await this.backupSqliteFile(graphSourcePath, dest);
    return dest;
  }

  /**
   * Restore a previously snapshotted graph SQLite file into `targetPath`.
   */
  async rollbackGraph(name: string, targetPath: string): Promise<void> {
    this.requireReady();
    const snapshot = this.graphSnapshotPath(name);
    if (!fs.existsSync(snapshot)) {
      return;
    }
    const resolvedTarget = resolveDbPath(targetPath);
    if (resolvedTarget === ":memory:") {
      throw new ConfigurationError(
        "Cannot rollback graph into an in-memory database.",
      );
    }
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const side = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(side)) {
        fs.rmSync(side, { force: true });
      }
    }
    await safeSqliteBackup(snapshot, resolvedTarget);
  }

  /** Absolute path of the graph snapshot for a named checkpoint, if present. */
  graphSnapshotPath(name: string): string {
    return path.join(this.directory, `${sanitize(name)}.graph.db`);
  }

  private metaPath(name: string): string {
    return path.join(this.directory, `${sanitize(name)}.json`);
  }

  private snapshotPath(name: string): string {
    return path.join(this.directory, `${sanitize(name)}.db`);
  }

  private requireReady(): void {
    if (!this.ready) {
      throw new DatabaseError(
        "Checkpoint provider is not open. Call ready() / open first.",
      );
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assertCheckpointName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError("checkpoint name must be a non-empty string");
  }
  if (name.length > 128) {
    throw new ValidationError("checkpoint name must be <= 128 characters");
  }
}

function resolveDbPath(connectionString: string): string {
  if (connectionString === ":memory:") return ":memory:";
  return path.isAbsolute(connectionString)
    ? connectionString
    : path.resolve(process.cwd(), connectionString);
}

/**
 * Consistent snapshot using SQLite backup API when available,
 * falling back to WAL checkpoint + file copy.
 */
async function safeSqliteBackup(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { force: true });
  }

  let source: DatabaseSync | null = null;
  let dest: DatabaseSync | null = null;
  try {
    source = new DatabaseSync(sourcePath);
    try {
      source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore checkpoint failures on read-only / busy DBs
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
      // Fallback: close and copy main db (+ wal if present after checkpoint)
      source.close();
      source = null;
      dest.close();
      dest = null;
      fs.copyFileSync(sourcePath, destPath);
    }
  } catch (error) {
    throw new DatabaseError(
      `Failed to execute checkpoint()\nReason:\n${error instanceof Error ? error.message : String(error)}\nSuggestion:\nEnsure no exclusive lock is held and the destination directory is writable.`,
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
