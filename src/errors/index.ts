/**
 * Operation-scoped errors with stable `code`, human `reason`, and actionable `suggestion`.
 *
 * All Wolbarg errors extend {@link WolbargError} so callers can use `instanceof`
 * checks and read structured fields in IDE hover docs.
 */

/**
 * Base class for all Wolbarg SDK errors.
 *
 * @property code - Stable machine-readable error code (e.g. `"VALIDATION_ERROR"`).
 * @property reason - Short explanation of why the operation failed.
 * @property suggestion - Actionable fix hint for developers.
 * @property operation - Facade method name when applicable (e.g. `"recall"`).
 */
export class WolbargError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly suggestion?: string;
  readonly operation?: string;

  /**
   * @param message - Human-readable error message.
   * @param code - Stable error code string.
   * @param options - Optional cause, reason, suggestion, and operation name.
   */
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

/** Thrown when SDK initialization or `open()` fails. */
export class InitializationError extends WolbargError {
  /**
   * @param message - Description of the initialization failure.
   * @param options - Optional cause and structured hints.
   */
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

/**
 * Thrown when configuration values are missing, invalid, or incompatible.
 * Also used for missing optional peer packages (PDF, OCR, Neo4j, etc.).
 */
export class ConfigurationError extends WolbargError {
  /**
   * @param message - Description of the misconfiguration.
   * @param options - Optional cause, reason, suggestion, and operation name.
   */
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

/** Thrown when method arguments fail validation before reaching storage. */
export class ValidationError extends WolbargError {
  /**
   * @param message - Which argument failed and why.
   * @param options - Optional cause and structured hints.
   */
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

/** Thrown when a low-level database read/write fails. */
export class DatabaseError extends WolbargError {
  /**
   * @param message - Operation-scoped failure message.
   * @param options - Optional underlying `cause` and hints.
   */
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
 * Stable code: `WOLBARG_STORAGE_LOCKED`.
 */
export class StorageLockedError extends WolbargError {
  /**
   * @param message - Lock contention description.
   * @param options - Typically includes suggestion to tune concurrency or use Postgres.
   */
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

/** Thrown when an embedding API request fails or returns invalid vectors. */
export class EmbeddingError extends WolbargError {
  /**
   * @param message - Embedding failure description.
   * @param options - Optional HTTP cause and provider hints.
   */
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

/** Thrown when LLM-based memory compression (summarization) fails. */
export class CompressionError extends WolbargError {
  /**
   * @param message - Compression failure description.
   * @param options - Optional LLM cause chain.
   */
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

/** Thrown when a requested memory id does not exist or is archived. */
export class MemoryNotFoundError extends WolbargError {
  /**
   * @param message - Which memory was not found.
   * @param options - Optional operation context.
   */
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
 * Thrown when a method requires an optional provider that was not configured
 * (reranker, OCR, graph, LLM for extract mode, etc.).
 */
export class ProviderNotConfiguredError extends ConfigurationError {
  readonly provider: string;

  /**
   * @param provider - Provider name (e.g. `"reranker"`, `"graph"`).
   * @param method - Facade method that requires the provider.
   * @param hint - Install or config instruction shown to the developer.
   */
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
  /**
   * @param backend - Graph backend name (e.g. `"neo4j"`).
   * @param operation - Requested operation (e.g. `"checkpoint"`).
   */
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

/**
 * Map low-level SQLite / driver errors into actionable {@link WolbargError} subclasses.
 *
 * Preserves existing {@link WolbargError} instances unchanged. Recognizes lock
 * contention, missing files, and read-only database errors.
 *
 * @param operation - Facade method name for the error message (e.g. `"remember"`).
 * @param error - Raw thrown value from the driver.
 * @returns A typed {@link WolbargError} subclass with `reason` and `suggestion`.
 */
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
