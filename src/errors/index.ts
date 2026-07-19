/**
 * Operation-scoped errors with reason + suggestion for developer experience.
 */

/** Base class for all Wolbarg errors. */
export class WolbargError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly suggestion?: string;
  readonly operation?: string;

  constructor(
    message: string,
    code: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, options);
    this.name = "WolbargError";
    this.code = code;
    this.reason = options?.reason;
    this.suggestion = options?.suggestion;
    this.operation = options?.operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when SDK initialization fails. */
export class InitializationError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "INITIALIZATION_ERROR", options);
    this.name = "InitializationError";
  }
}

/** Thrown when configuration values are missing or invalid. */
export class ConfigurationError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "CONFIGURATION_ERROR", options);
    this.name = "ConfigurationError";
  }
}

/** Thrown when method arguments fail validation. */
export class ValidationError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "VALIDATION_ERROR", options);
    this.name = "ValidationError";
  }
}

/** Thrown when a database operation fails. */
export class DatabaseError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "DATABASE_ERROR", options);
    this.name = "DatabaseError";
  }
}

/**
 * Thrown when SQLite write-lock retries are exhausted.
 * Stable code: WOLBARG_STORAGE_LOCKED
 */
export class StorageLockedError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "WOLBARG_STORAGE_LOCKED", options);
    this.name = "StorageLockedError";
  }
}

/** Thrown when an embedding request fails. */
export class EmbeddingError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "EMBEDDING_ERROR", options);
    this.name = "EmbeddingError";
  }
}

/** Thrown when compression (LLM summarization) fails. */
export class CompressionError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "COMPRESSION_ERROR", options);
    this.name = "CompressionError";
  }
}

/** Thrown when a requested memory does not exist. */
export class MemoryNotFoundError extends WolbargError {
  constructor(
    message: string,
    options?: ErrorOptions & {
      reason?: string;
      suggestion?: string;
      operation?: string;
    },
  ) {
    super(message, "MEMORY_NOT_FOUND", options);
    this.name = "MemoryNotFoundError";
  }
}

/**
 * Thrown when a method requires an optional provider that was not configured.
 */
export class ProviderNotConfiguredError extends ConfigurationError {
  readonly provider: string;

  constructor(provider: string, method: string, hint: string) {
    super(`${method} requires ${provider} — ${hint}`, {
      operation: method,
      reason: `${provider} was not configured`,
      suggestion: hint,
    });
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
  }
}

/**
 * Thrown when graph checkpoint / rollback / export / import is requested for a
 * network-backed graph provider (e.g. Neo4j). File-backed SQLite graph supports
 * snapshots; Neo4j does not in v1 — we refuse rather than silently skip.
 */
export class GraphCheckpointNotSupportedError extends WolbargError {
  constructor(backend: string, operation: string) {
    super(
      `graph checkpoint not supported for network-backed graph providers (${backend})`,
      "GRAPH_CHECKPOINT_NOT_SUPPORTED",
      {
        operation,
        reason: `${backend} is networked / not file-backed`,
        suggestion:
          "Use sqliteGraph({ path }) for local snapshots, or checkpoint memory storage only without a network graph provider.",
      },
    );
    this.name = "GraphCheckpointNotSupportedError";
  }
}

/** Map low-level SQLite / driver errors into actionable operation errors. */
export function wrapOperationError(
  operation: string,
  error: unknown,
): WolbargError {
  // Preserve typed SDK errors so callers can still use instanceof checks.
  if (error instanceof WolbargError) {
    return error;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (lower.includes("database is locked") || lower.includes("sqlite_busy")) {
    return new StorageLockedError(formatOperationMessage(operation, raw), {
      cause: error instanceof Error ? error : undefined,
      operation,
      reason: "SQLite database locked",
      suggestion:
        "Increase concurrency.maxRetries or concurrency.lockTimeoutMs, or consider the Postgres backend for high-concurrency multi-agent workloads.",
    });
  }

  if (lower.includes("no such file") || lower.includes("enoent")) {
    return new DatabaseError(formatOperationMessage(operation, raw), {
      cause: error instanceof Error ? error : undefined,
      operation,
      reason: "Database file not found",
      suggestion: "Check the database path and ensure the directory exists.",
    });
  }

  if (lower.includes("readonly") || lower.includes("read-only")) {
    return new DatabaseError(formatOperationMessage(operation, raw), {
      cause: error instanceof Error ? error : undefined,
      operation,
      reason: "Database opened as read-only",
      suggestion: "Open the database with write permissions or choose another path.",
    });
  }

  return new DatabaseError(formatOperationMessage(operation, raw), {
    cause: error instanceof Error ? error : undefined,
    operation,
    reason: raw,
    suggestion: "Inspect the underlying cause and retry the operation.",
  });
}

function formatOperationMessage(operation: string, reason: string | WolbargError): string {
  const reasonText =
    typeof reason === "string" ? reason : reason.reason ?? reason.message;
  return `Failed to execute ${operation}()\nReason:\n${reasonText}`;
}
