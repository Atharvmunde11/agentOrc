/**
 * Database-agnostic checkpoint contract.
 * Snapshots memory state so callers can rollback without third-party libs.
 */

export interface CheckpointMeta {
  name: string;
  description: string | null;
  createdAt: string;
  sdkVersion: string;
  provider: string;
  /** Absolute path or URI of the snapshot artifact. */
  snapshotPath: string;
  /** Absolute path or URI of the source memory database at creation time. */
  sourcePath: string;
  sizeBytes: number;
}

export interface CreateCheckpointOptions {
  description?: string;
}

export interface CheckpointProvider {
  readonly name: string;

  /** Prepare checkpoint storage (directories / tables). */
  open(): Promise<void>;

  close(): Promise<void>;

  /**
   * Create a named snapshot of the current memory database.
   * Must fail if the name already exists (never overwrite).
   */
  checkpoint(
    name: string,
    sourcePath: string,
    options?: CreateCheckpointOptions,
  ): Promise<CheckpointMeta>;

  /** Restore the memory database from a named checkpoint. */
  rollback(name: string, targetPath: string): Promise<CheckpointMeta>;

  /** Permanently remove a checkpoint and its snapshot files. */
  deleteCheckpoint(name: string): Promise<boolean>;

  listCheckpoints(): Promise<CheckpointMeta[]>;

  getCheckpoint(name: string): Promise<CheckpointMeta | null>;
}
