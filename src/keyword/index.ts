/**
 * Keyword / BM25 search providers for hybrid recall.
 *
 * Use these when you want lexical (BM25) scoring alongside semantic vector search.
 * Pass a {@link KeywordSearchProvider} to Wolbarg retrieval config, or rely on
 * native FTS when the storage backend supports it.
 *
 * @example
 * ```ts
 * import { bm25 } from "wolbarg/keyword";
 *
 * const keyword = bm25({ k1: 1.2, b: 0.75 });
 * const hits = await keyword.search("billing issue", documents, 10);
 * ```
 */

/** A single keyword search hit with memory id and BM25 score. */
export interface KeywordSearchHit {
  /** Memory UUID that matched the query. */
  memoryId: string;
  /** BM25 relevance score (higher is better). */
  score: number;
}

/** Document passed to keyword search — typically memory id + text body. */
export interface KeywordDocument {
  /** Memory UUID. */
  id: string;
  /** Searchable text content. */
  text: string;
}

/**
 * Contract for keyword / lexical search backends.
 *
 * Implement this interface to plug in a custom BM25, Elasticsearch, or FTS adapter.
 * Wolbarg calls {@link KeywordSearchProvider.search} during hybrid recall when no
 * native storage keyword index is available.
 *
 * @example Custom provider
 * ```ts
 * const myKeyword: KeywordSearchProvider = {
 *   name: "my-fts",
 *   async search(query, documents, topK) {
 *     // score documents and return topK hits
 *     return [{ memoryId: documents[0]!.id, score: 1.0 }];
 *   },
 * };
 * ```
 */
export interface KeywordSearchProvider {
  /** Provider identifier (e.g. `"bm25"`, `"fts5"`). */
  readonly name: string;
  /**
   * Rank documents by lexical relevance to `query`.
   * @param query - User search string.
   * @param documents - Candidate memories to score.
   * @param topK - Maximum hits to return.
   * @returns Hits sorted by score descending.
   */
  search(
    query: string,
    documents: KeywordDocument[],
    topK: number,
  ): Promise<KeywordSearchHit[]>;
}

/**
 * In-memory Okapi BM25 keyword search.
 *
 * Suitable for small corpora or when storage has no native FTS. Tunable via
 * {@link https://en.wikipedia.org/wiki/Okapi_BM25 | BM25} parameters `k1` and `b`.
 */
export class Bm25KeywordSearchProvider implements KeywordSearchProvider {
  readonly name = "bm25";
  private readonly k1: number;
  private readonly b: number;

  /**
   * @param options - BM25 tuning parameters.
   * @param options.k1 - Term frequency saturation (default `1.2`).
   * @param options.b - Length normalization (default `0.75`).
   */
  constructor(options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
  }

  /** @inheritdoc */
  async search(
    query: string,
    documents: KeywordDocument[],
    topK: number,
  ): Promise<KeywordSearchHit[]> {
    if (documents.length === 0 || topK <= 0) {
      return [];
    }

    const docs = documents.map((doc) => ({
      id: doc.id,
      tokens: tokenize(doc.text),
    }));
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const N = docs.length;
    const avgdl =
      docs.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(N, 1);

    const df = new Map<string, number>();
    for (const term of new Set(queryTokens)) {
      let count = 0;
      for (const doc of docs) {
        if (doc.tokens.includes(term)) {
          count += 1;
        }
      }
      df.set(term, count);
    }

    const scored = docs.map((doc) => {
      const tfMap = new Map<string, number>();
      for (const token of doc.tokens) {
        tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
      }
      let score = 0;
      for (const term of queryTokens) {
        const tf = tfMap.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom =
          tf + this.k1 * (1 - this.b + this.b * (doc.tokens.length / avgdl));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      return { memoryId: doc.id, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0).slice(0, topK);
  }
}

/** Tokenize text for BM25 (Unicode letters/numbers, min length 2). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Factory for the default in-memory BM25 keyword provider.
 *
 * @param options - Optional BM25 tuning (`k1`, `b`).
 * @returns A {@link KeywordSearchProvider} ready for hybrid recall.
 *
 * @example
 * ```ts
 * const keyword = bm25();
 * ```
 */
export function bm25(options?: { k1?: number; b?: number }): KeywordSearchProvider {
  return new Bm25KeywordSearchProvider(options);
}
