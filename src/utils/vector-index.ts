/**
 * Contiguous in-memory vector index for blob backends (e.g. win32-arm64
 * without sqlite-vec). Stores L2-normalized embeddings for O(n) top-k
 * via fused multiply-add + partial selection — no per-search allocations
 * of distance arrays when n is large.
 */

export interface InMemoryHit {
  memoryRowid: number;
  distance: number;
}

export class InMemoryVectorIndex {
  private readonly dims: number;
  private rowids: number[] = [];
  private data: Float32Array;
  private count = 0;
  private readonly rowidToSlot = new Map<number, number>();

  constructor(dimensions: number, initialCapacity = 256) {
    this.dims = dimensions;
    this.data = new Float32Array(initialCapacity * dimensions);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.rowids.length = 0;
    this.rowidToSlot.clear();
    this.count = 0;
  }

  upsert(rowid: number, embedding: Float32Array): void {
    const existing = this.rowidToSlot.get(rowid);
    const slot =
      existing !== undefined
        ? existing
        : (() => {
            this.ensureCapacity(this.count + 1);
            const s = this.count;
            this.rowids[s] = rowid;
            this.rowidToSlot.set(rowid, s);
            this.count += 1;
            return s;
          })();

    const dims = this.dims;
    const base = slot * dims;
    const data = this.data;
    const len = embedding.length < dims ? embedding.length : dims;
    let norm = 0;
    for (let i = 0; i < len; i += 1) {
      const v = embedding[i]!;
      data[base + i] = v;
      norm += v * v;
    }
    for (let i = len; i < dims; i += 1) {
      data[base + i] = 0;
    }
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < len; i += 1) {
        data[base + i]! *= inv;
      }
    }
  }

  remove(rowid: number): void {
    const slot = this.rowidToSlot.get(rowid);
    if (slot === undefined) {
      return;
    }
    const last = this.count - 1;
    if (slot !== last) {
      const lastRowid = this.rowids[last]!;
      this.data.copyWithin(
        slot * this.dims,
        last * this.dims,
        (last + 1) * this.dims,
      );
      this.rowids[slot] = lastRowid;
      this.rowidToSlot.set(lastRowid, slot);
    }
    this.rowidToSlot.delete(rowid);
    this.count = last;
  }

  /** Top-k by cosine distance (1 - dot) assuming query is L2-normalized. */
  search(queryNormalized: Float32Array, topK: number): InMemoryHit[] {
    const n = this.count;
    if (n === 0 || topK <= 0) {
      return [];
    }
    const dims = this.dims;
    const data = this.data;
    const rowids = this.rowids;
    const k = topK < n ? topK : n;

    // Small-k: maintain a max-heap of distances (worst of the best-k at root).
    const heapDist = new Float64Array(k);
    const heapRow = new Int32Array(k);
    let heapSize = 0;

    for (let i = 0; i < n; i += 1) {
      const base = i * dims;
      let dot = 0;
      // Manual 4-wide unroll for hot loop
      let d = 0;
      for (; d + 3 < dims; d += 4) {
        dot +=
          queryNormalized[d]! * data[base + d]! +
          queryNormalized[d + 1]! * data[base + d + 1]! +
          queryNormalized[d + 2]! * data[base + d + 2]! +
          queryNormalized[d + 3]! * data[base + d + 3]!;
      }
      for (; d < dims; d += 1) {
        dot += queryNormalized[d]! * data[base + d]!;
      }
      const distance = 1 - dot;

      if (heapSize < k) {
        heapDist[heapSize] = distance;
        heapRow[heapSize] = rowids[i]!;
        heapSize += 1;
        if (heapSize === k) {
          buildMaxHeap(heapDist, heapRow, k);
        }
      } else if (distance < heapDist[0]!) {
        heapDist[0] = distance;
        heapRow[0] = rowids[i]!;
        siftDown(heapDist, heapRow, 0, k);
      }
    }

    const hits: InMemoryHit[] = new Array(heapSize);
    for (let i = 0; i < heapSize; i += 1) {
      hits[i] = { memoryRowid: heapRow[i]!, distance: heapDist[i]! };
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  private ensureCapacity(needed: number): void {
    if (needed * this.dims <= this.data.length) {
      return;
    }
    let cap = this.data.length / this.dims;
    if (cap < 1) cap = 1;
    while (cap < needed) cap *= 2;
    const next = new Float32Array(cap * this.dims);
    next.set(this.data.subarray(0, this.count * this.dims));
    this.data = next;
  }
}

/** L2-normalize into a new Float32Array of exactly `dims` length. */
export function normalizeEmbedding(
  embedding: Float32Array,
  dims = embedding.length,
): Float32Array {
  return normalizeInto(embedding, dims);
}

function normalizeInto(embedding: Float32Array, dims: number): Float32Array {
  const out = new Float32Array(dims);
  const len = embedding.length < dims ? embedding.length : dims;
  let norm = 0;
  for (let i = 0; i < len; i += 1) {
    const v = embedding[i]!;
    out[i] = v;
    norm += v * v;
  }
  if (norm === 0) {
    return out;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < len; i += 1) {
    out[i]! *= inv;
  }
  return out;
}

function buildMaxHeap(
  dist: Float64Array,
  rows: Int32Array,
  n: number,
): void {
  for (let i = (n >> 1) - 1; i >= 0; i -= 1) {
    siftDown(dist, rows, i, n);
  }
}

function siftDown(
  dist: Float64Array,
  rows: Int32Array,
  i: number,
  n: number,
): void {
  for (;;) {
    let largest = i;
    const left = (i << 1) + 1;
    const right = left + 1;
    if (left < n && dist[left]! > dist[largest]!) largest = left;
    if (right < n && dist[right]! > dist[largest]!) largest = right;
    if (largest === i) return;
    const td = dist[i]!;
    dist[i] = dist[largest]!;
    dist[largest] = td;
    const tr = rows[i]!;
    rows[i] = rows[largest]!;
    rows[largest] = tr;
    i = largest;
  }
}
