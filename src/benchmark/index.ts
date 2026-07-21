/**
 * Internal benchmark helpers for CLI and Studio performance tooling.
 *
 * @internal Exported for harness scripts — not part of the stable public API surface.
 */

/** Single timed iteration result. */
export interface BenchmarkSample {
  /** Benchmark scenario name. */
  name: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the iteration completed without throwing. */
  ok: boolean;
  /** Error message when `ok` is false. */
  error?: string;
}

/** Aggregated benchmark report with percentile summary. */
export interface BenchmarkReport {
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 end timestamp. */
  finishedAt: string;
  /** Raw per-iteration samples. */
  samples: BenchmarkSample[];
  /** Rollup statistics across successful iterations. */
  summary: {
    count: number;
    ok: number;
    failed: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
}

/**
 * Run a benchmark function for a fixed number of iterations.
 *
 * @param name - Scenario label attached to each sample.
 * @param iterations - Number of times to invoke `fn`.
 * @param fn - Async or sync work to measure.
 * @returns One {@link BenchmarkSample} per iteration (failures captured, not thrown).
 */
export async function runBenchmark(
  name: string,
  iterations: number,
  fn: () => Promise<void> | void,
): Promise<BenchmarkSample[]> {
  const samples: BenchmarkSample[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    try {
      await fn();
      samples.push({
        name,
        durationMs: performance.now() - t0,
        ok: true,
      });
    } catch (error) {
      samples.push({
        name,
        durationMs: performance.now() - t0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return samples;
}

/**
 * Summarize benchmark samples into a report with avg / p50 / p95 / p99 latencies.
 *
 * @param samples - Output from {@link runBenchmark}.
 * @param startedAt - ISO start time for the run.
 * @param finishedAt - ISO end time for the run.
 * @returns {@link BenchmarkReport} suitable for JSON export.
 */
export function summarizeBenchmark(
  samples: BenchmarkSample[],
  startedAt: string,
  finishedAt: string,
): BenchmarkReport {
  const durations = samples
    .filter((s) => s.ok)
    .map((s) => s.durationMs)
    .sort((a, b) => a - b);
  const avg =
    durations.length === 0
      ? 0
      : durations.reduce((a, b) => a + b, 0) / durations.length;

  return {
    startedAt,
    finishedAt,
    samples,
    summary: {
      count: samples.length,
      ok: samples.filter((s) => s.ok).length,
      failed: samples.filter((s) => !s.ok).length,
      avgMs: avg,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
    },
  };
}

/** Compute percentile from a pre-sorted duration array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}
