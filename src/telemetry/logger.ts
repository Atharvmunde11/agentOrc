/**
 * Cross-platform structured logger gated by TelemetryLogLevel.
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
  constructor(private level: TelemetryLogLevel = "info") {}

  setLevel(level: TelemetryLogLevel): void {
    this.level = level;
  }

  getLevel(): TelemetryLogLevel {
    return this.level;
  }

  error(message: string, extra?: unknown): void {
    this.write("error", message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.write("warn", message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.write("info", message, extra);
  }

  debug(message: string, extra?: unknown): void {
    this.write("debug", message, extra);
  }

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
