/**
 * Retrieval pipeline — fusion, MMR, adaptive candidate selection.
 */

import type { HybridConfig, MmrConfig, RecallResult } from "../types/index.js";

export interface ScoredCandidate {
  id: string;
  semanticScore: number;
  keywordScore: number;
  fusedScore: number;
  result: RecallResult;
}

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
 * Maximal Marginal Relevance diversification.
 * Uses character Jaccard as a cheap token-overlap proxy for embedding similarity.
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

export function adaptiveFetchK(
  topK: number,
  overFetchFactor: number,
  hasFilters: boolean,
): number {
  const factor = hasFilters ? Math.max(overFetchFactor, 4) : overFetchFactor;
  return Math.min(Math.max(Math.ceil(topK * factor), topK), 1000);
}
