/**
 * Database-agnostic checkpoint contract for memory snapshots.
 *
 * Checkpoints copy file-backed SQLite memory databases so callers can rollback
 * without third-party backup libraries.
 */

/** Metadata recorded for each named checkpoint. */
export interface CheckpointMeta {
  /** User-provided checkpoint name (unique). */
  name: string;
  /** Optional human description. */
  description: string | null;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Wolbarg SDK version that created the checkpoint. */
  sdkVersion: string;
  /** Storage provider name (e.g. `"sqlite"`). */
  provider: string;
  /** Absolute path or URI of the snapshot artifact. */
  snapshotPath: string;
  /** Absolute path or URI of the source memory database at creation time. */
  sourcePath: string;
  /** On-disk snapshot size in bytes. */
  sizeBytes: number;
}

/** Options passed to {@link CheckpointProvider.checkpoint}. */
export interface CreateCheckpointOptions {
  /** Optional description stored in {@link CheckpointMeta}. */
  description?: string;
}

/**
 * Checkpoint provider contract — create, list, restore, and delete snapshots.
 *
 * Implement this interface for custom snapshot storage (S3, tarball, etc.).
 * Built-in: {@link SqliteCheckpointProvider}.
 *
 * @example
 * ```ts
 * await checkpointProvider.checkpoint("pre-migration", sourceDbPath, {
 *   description: "Before schema migration",
 * });
 * ```
 */
export interface CheckpointProvider {
  /** Provider identifier. */
  readonly name: string;

  /** Prepare checkpoint storage (directories / tables). */
  open(): Promise<void>;

  /** Close checkpoint storage handles. */
  close(): Promise<void>;

  /**
   * Create a named snapshot of the current memory database.
   * Must fail if the name already exists (never overwrite).
   *
   * @param name - Unique checkpoint name.
   * @param sourcePath - Live memory database path to snapshot.
   * @param options - Optional description.
   */
  checkpoint(
    name: string,
    sourcePath: string,
    options?: CreateCheckpointOptions,
  ): Promise<CheckpointMeta>;

  /**
   * Restore the memory database from a named checkpoint.
   *
   * @param name - Existing checkpoint name.
   * @param targetPath - Path to overwrite with the snapshot.
   */
  rollback(name: string, targetPath: string): Promise<CheckpointMeta>;

  /**
   * Permanently remove a checkpoint and its snapshot files.
   * @returns `true` when a checkpoint was deleted.
   */
  deleteCheckpoint(name: string): Promise<boolean>;

  /** List all checkpoints ordered by creation time. */
  listCheckpoints(): Promise<CheckpointMeta[]>;

  /**
   * Fetch metadata for one checkpoint.
   * @param name - Checkpoint name.
   */
  getCheckpoint(name: string): Promise<CheckpointMeta | null>;
}
