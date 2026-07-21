/**
 * Retrieval pipeline — score fusion, MMR diversification, and adaptive over-fetch.
 *
 * Internal helpers used by `recall()` to combine semantic and keyword signals,
 * diversify results, and size candidate pools before reranking.
 */

import type { HybridConfig, MmrConfig, RecallResult } from "../types/index.js";

/** Candidate with separate semantic, keyword, and fused scores during recall. */
export interface ScoredCandidate {
  /** Memory UUID. */
  id: string;
  /** Normalized semantic similarity score. */
  semanticScore: number;
  /** Normalized keyword / BM25 score. */
  keywordScore: number;
  /** Weighted combination of semantic and keyword scores. */
  fusedScore: number;
  /** Full recall result for downstream ranking. */
  result: RecallResult;
}

/**
 * Fuse semantic and keyword score maps using configured weights.
 *
 * Scores are max-normalized per channel before weighting so scales are comparable.
 *
 * @param semantic - Memory id → raw semantic score.
 * @param keyword - Memory id → raw keyword score.
 * @param weights - Hybrid weights (must sum conceptually to 1.0 in typical configs).
 * @returns Memory id → fused score.
 */
export function fuseScores(
  semantic: Map<string, number>,
  keyword: Map<string, number>,
  weights: Required<HybridConfig>,
): Map<string, number> {
  const ids = new Set([...semantic.keys(), ...keyword.keys()]);
  const fused = new Map<string, number>();
  const semMax = Math.max(...semantic.values(), 1e-9);
  const kwMax = Math.max(...keyword.values(), 1e-9);

  for (const id of ids) {
    const s = (semantic.get(id) ?? 0) / semMax;
    const k = (keyword.get(id) ?? 0) / kwMax;
    fused.set(
      id,
      weights.semanticWeight * s + weights.keywordWeight * k,
    );
  }
  return fused;
}

/**
 * Resolve hybrid recall config to concrete weights, or `null` when hybrid is off.
 *
 * @param hybrid - `true` (defaults), `false`, or partial {@link HybridConfig}.
 * @returns Resolved weights or `null` when hybrid search is disabled.
 */
export function resolveHybridWeights(
  hybrid: boolean | HybridConfig | undefined,
): Required<HybridConfig> | null {
  if (hybrid === false || hybrid === undefined) {
    return null;
  }
  if (hybrid === true) {
    return { semanticWeight: 0.7, keywordWeight: 0.3 };
  }
  return {
    semanticWeight: hybrid.semanticWeight ?? 0.7,
    keywordWeight: hybrid.keywordWeight ?? 0.3,
  };
}

/**
 * Resolve MMR lambda from config, or `null` when MMR is off.
 *
 * @param mmr - `true` (lambda 0.5), `false`, or {@link MmrConfig}.
 * @returns Lambda in `[0, 1]` or `null` when diversification is disabled.
 */
export function resolveMmr(
  mmr: boolean | MmrConfig | undefined,
): number | null {
  if (mmr === false || mmr === undefined) {
    return null;
  }
  if (mmr === true) {
    return 0.5;
  }
  return mmr.lambda ?? 0.5;
}

/**
 * Maximal Marginal Relevance (MMR) diversification of recall candidates.
 *
 * Balances relevance (`similarity`) against redundancy using character Jaccard
 * as a cheap token-overlap proxy for embedding similarity.
 *
 * @param candidates - Scored recall results (pre-sorted by relevance).
 * @param topK - Number of diverse results to select.
 * @param lambda - Trade-off: `1` = pure relevance, `0` = pure diversity.
 * @returns Reordered subset of at most `topK` candidates.
 */
export function applyMmr(
  candidates: RecallResult[],
  topK: number,
  lambda: number,
): RecallResult[] {
  if (candidates.length <= topK) {
    return candidates;
  }

  const selected: RecallResult[] = [];
  const remaining = [...candidates];

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      const relevance = candidate.similarity;
      let maxSim = 0;
      for (const chosen of selected) {
        maxSim = Math.max(
          maxSim,
          jaccard(candidate.content.text, chosen.content.text),
        );
      }
      const score = lambda * relevance - (1 - lambda) * maxSim;
        const best = remaining[bestIdx]!;
        if (
          score > bestScore ||
          (score === bestScore && candidate.id < best.id)
        ) {
        bestScore = score;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/** Token-set Jaccard similarity between two strings (case-insensitive). */
function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      inter += 1;
    }
  }
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compute how many vector candidates to fetch before filtering / reranking.
 *
 * Uses a higher over-fetch factor when metadata filters are active because
 * post-filtering shrinks the candidate pool.
 *
 * @param topK - Final number of results requested by the caller.
 * @param overFetchFactor - Base multiplier from retrieval config.
 * @param hasFilters - Whether metadata or agent filters will post-filter hits.
 * @returns Candidate pool size capped at 1000.
 */
export function adaptiveFetchK(
  topK: number,
  overFetchFactor: number,
  hasFilters: boolean,
): number {
  const factor = hasFilters ? Math.max(overFetchFactor, 4) : overFetchFactor;
  return Math.min(Math.max(Math.ceil(topK * factor), topK), 1000);
}
