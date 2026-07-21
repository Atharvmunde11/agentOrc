/**
 * Cross-platform structured logger gated by {@link TelemetryLogLevel}.
 *
 * Used internally by {@link TelemetryEmitter}; also exported for adapter packages.
 */

import type { TelemetryLogLevel } from "./types.js";

const LEVEL_ORDER: Record<TelemetryLogLevel, number> = {
  off: 100,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export class WolbargLogger {
  /** @param level - Minimum level to print (default `"info"`). */
  constructor(private level: TelemetryLogLevel = "info") {}

  /** Change the minimum log level at runtime. */
  setLevel(level: TelemetryLogLevel): void {
    this.level = level;
  }

  /** @returns Current minimum log level. */
  getLevel(): TelemetryLogLevel {
    return this.level;
  }

  /** Log at error level. */
  error(message: string, extra?: unknown): void {
    this.write("error", message, extra);
  }

  /** Log at warn level.
   * @param message - Primary log line.
   * @param extra - Optional structured payload.
   */
  warn(message: string, extra?: unknown): void {
    this.write("warn", message, extra);
  }

  /** Log at info level.
   * @param message - Primary log line.
   * @param extra - Optional structured payload.
   */
  info(message: string, extra?: unknown): void {
    this.write("info", message, extra);
  }

  /** Log at debug level.
   * @param message - Primary log line.
   * @param extra - Optional structured payload.
   */
  debug(message: string, extra?: unknown): void {
    this.write("debug", message, extra);
  }

  /** Log at trace level.
   * @param message - Primary log line.
   * @param extra - Optional structured payload.
   */
  trace(message: string, extra?: unknown): void {
    this.write("trace", message, extra);
  }

  private write(level: TelemetryLogLevel, message: string, extra?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    if (this.level === "off") {
      return;
    }
    const line = `[wolbarg:${level}] ${message}`;
    if (level === "error") {
      console.error(line, extra ?? "");
    } else if (level === "warn") {
      console.warn(line, extra ?? "");
    } else {
      console.log(line, extra ?? "");
    }
  }
}
