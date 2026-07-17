/**
 * Internal benchmark helpers for CLI / Studio later.
 * @internal
 */

export interface BenchmarkSample {
  name: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface BenchmarkReport {
  startedAt: string;
  finishedAt: string;
  samples: BenchmarkSample[];
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}
