/**
 * Cosine distance helpers for the blob vector fallback backend.
 */

/** Cosine distance = 1 - cosine_similarity (matches sqlite-vec cosine metric). */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineDistance dimension mismatch: a.length=${a.length}, b.length=${b.length}`,
    );
  }
  const len = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 1;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * Decode a float32 embedding from a SQLite BLOB.
 * Avoids a copy when the underlying ArrayBuffer is already aligned/owned.
 */
export function bufferToEmbedding(data: Uint8Array | Buffer): Float32Array {
  const byteOffset = (data as Uint8Array).byteOffset ?? 0;
  const byteLength = data.byteLength;
  if (byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(
      (data as Uint8Array).buffer,
      byteOffset,
      byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
  }
  const copy = new Uint8Array(byteLength);
  copy.set(data);
  return new Float32Array(copy.buffer);
}
