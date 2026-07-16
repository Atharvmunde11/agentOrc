/**
 * Custom error hierarchy for Wolbarg.
 * Raw SQLite / network errors are never exposed to consumers.
 */

/** Base class for all Wolbarg errors. */
export class WolbargError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WolbargError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when SDK initialization fails. */
export class InitializationError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "INITIALIZATION_ERROR", options);
    this.name = "InitializationError";
  }
}

/** Thrown when configuration values are missing or invalid. */
export class ConfigurationError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIGURATION_ERROR", options);
    this.name = "ConfigurationError";
  }
}

/** Thrown when method arguments fail validation. */
export class ValidationError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "VALIDATION_ERROR", options);
    this.name = "ValidationError";
  }
}

/** Thrown when a database operation fails. */
export class DatabaseError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "DATABASE_ERROR", options);
    this.name = "DatabaseError";
  }
}

/** Thrown when an embedding request fails. */
export class EmbeddingError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "EMBEDDING_ERROR", options);
    this.name = "EmbeddingError";
  }
}

/** Thrown when compression (LLM summarization) fails. */
export class CompressionError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "COMPRESSION_ERROR", options);
    this.name = "CompressionError";
  }
}

/** Thrown when a requested memory does not exist. */
export class MemoryNotFoundError extends WolbargError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "MEMORY_NOT_FOUND", options);
    this.name = "MemoryNotFoundError";
  }
}

/**
 * Thrown when a method requires an optional provider that was not configured.
 * Prefer TypeScript narrowing (e.g. compress without llm) when possible.
 */
export class ProviderNotConfiguredError extends ConfigurationError {
  readonly provider: string;

  constructor(provider: string, method: string, hint: string) {
    super(
      `${method} requires ${provider} — ${hint}`,
    );
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
  }
}
