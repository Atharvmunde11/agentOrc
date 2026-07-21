/**
 * Chunking strategies for document ingestion.
 *
 * Long documents are split into overlapping chunks before embedding and storage.
 * Choose a strategy via {@link createChunkingStrategy} or let ingest auto-detect
 * with {@link inferChunkingStrategy}.
 *
 * @example
 * ```ts
 * import { createChunkingStrategy } from "wolbarg/chunking";
 *
 * const chunker = createChunkingStrategy("sentence");
 * const chunks = chunker.chunk(documentText, { chunkSize: 800, overlap: 100 });
 * ```
 */

/** A single text chunk with stable index for ordering. */
export interface Chunk {
  /** Chunk body text. */
  text: string;
  /** Zero-based position in the original document. */
  index: number;
}

/** Options controlling chunk size and overlap. */
export interface ChunkingOptions {
  /** Target characters per chunk (default `800`, minimum `32`). */
  chunkSize?: number;
  /** Overlap between consecutive chunks (default `100`, capped at half of chunkSize). */
  overlap?: number;
}

/**
 * Contract for document chunking strategies.
 *
 * Implement this interface for custom splitters (token-based, semantic, etc.).
 * Wolbarg ingest calls {@link ChunkingStrategy.chunk} after parsing a document.
 */
export interface ChunkingStrategy {
  /** Strategy name (e.g. `"sentence"`, `"markdown"`). */
  readonly name: string;
  /**
   * Split `text` into ordered chunks.
   * @param text - Full document text.
   * @param options - Optional size and overlap overrides.
   * @returns Non-overlapping or sliding-window chunks with indices.
   */
  chunk(text: string, options?: ChunkingOptions): Chunk[];
}

/** Clamp and validate chunking options with safe defaults. */
function clampOptions(options?: ChunkingOptions): {
  chunkSize: number;
  overlap: number;
} {
  const chunkSize = Math.max(32, options?.chunkSize ?? 800);
  const overlap = Math.min(
    Math.max(0, options?.overlap ?? 100),
    Math.floor(chunkSize / 2),
  );
  return { chunkSize, overlap };
}

/** Merge logical pieces (sentences, paragraphs) into size-bounded chunks. */
function windowChunks(
  pieces: string[],
  chunkSize: number,
  overlap: number,
  joiner: string,
): Chunk[] {
  if (pieces.length === 0) {
    return [];
  }
  const chunks: Chunk[] = [];
  let buf = "";
  let index = 0;

  const flush = (): void => {
    const trimmed = buf.trim();
    if (trimmed) {
      chunks.push({ text: trimmed, index });
      index += 1;
    }
  };

  for (const piece of pieces) {
    const candidate = buf ? `${buf}${joiner}${piece}` : piece;
    if (candidate.length <= chunkSize) {
      buf = candidate;
      continue;
    }
    flush();
    if (piece.length > chunkSize) {
      // Hard-split oversized piece
      let start = 0;
      while (start < piece.length) {
        const end = Math.min(start + chunkSize, piece.length);
        chunks.push({ text: piece.slice(start, end).trim(), index });
        index += 1;
        start = Math.max(end - overlap, end);
      }
      buf = "";
    } else {
      buf = piece;
    }
  }
  flush();

  if (overlap > 0 && chunks.length > 1) {
    // Rebuild with overlap by sliding on joined text for stability
    const full = pieces.join(joiner);
    return slidingWindow(full, chunkSize, overlap);
  }
  return chunks;
}

/** Fixed-size sliding window over raw text. */
function slidingWindow(
  text: string,
  chunkSize: number,
  overlap: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const slice = text.slice(start, end).trim();
    if (slice) {
      chunks.push({ text: slice, index });
      index += 1;
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Character-based fixed window chunking (ignores sentence boundaries). */
export class FixedChunkingStrategy implements ChunkingStrategy {
  readonly name = "fixed";
  /** @inheritdoc */
  chunk(text: string, options?: ChunkingOptions): Chunk[] {
    const { chunkSize, overlap } = clampOptions(options);
    return slidingWindow(text, chunkSize, overlap);
  }
}

/** Sentence-boundary-aware chunking (splits on `.!?` followed by whitespace). */
export class SentenceChunkingStrategy implements ChunkingStrategy {
  readonly name = "sentence";
  /** @inheritdoc */
  chunk(text: string, options?: ChunkingOptions): Chunk[] {
    const { chunkSize, overlap } = clampOptions(options);
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return windowChunks(sentences, chunkSize, overlap, " ");
  }
}

/** Paragraph-boundary-aware chunking (splits on blank lines). */
export class ParagraphChunkingStrategy implements ChunkingStrategy {
  readonly name = "paragraph";
  /** @inheritdoc */
  chunk(text: string, options?: ChunkingOptions): Chunk[] {
    const { chunkSize, overlap } = clampOptions(options);
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return windowChunks(paragraphs, chunkSize, overlap, "\n\n");
  }
}

/** Markdown heading-aware chunking (splits on `#` headings; falls back to paragraph). */
export class MarkdownChunkingStrategy implements ChunkingStrategy {
  readonly name = "markdown";
  /** @inheritdoc */
  chunk(text: string, options?: ChunkingOptions): Chunk[] {
    const { chunkSize, overlap } = clampOptions(options);
    const sections = text
      .split(/(?=^#{1,6}\s)/m)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sections.length <= 1) {
      return new ParagraphChunkingStrategy().chunk(text, options);
    }
    return windowChunks(sections, chunkSize, overlap, "\n\n");
  }
}

/** Alias for {@link MarkdownChunkingStrategy}. */
export class HeadingChunkingStrategy implements ChunkingStrategy {
  readonly name = "heading";
  /** @inheritdoc */
  chunk(text: string, options?: ChunkingOptions): Chunk[] {
    return new MarkdownChunkingStrategy().chunk(text, options);
  }
}

/**
 * Factory for built-in chunking strategies.
 *
 * @param name - Strategy name (default `"sentence"`).
 * @returns A {@link ChunkingStrategy} instance.
 *
 * @example
 * ```ts
 * const chunker = createChunkingStrategy("markdown");
 * ```
 */
export function createChunkingStrategy(
  name: "fixed" | "sentence" | "paragraph" | "markdown" | "heading" = "sentence",
): ChunkingStrategy {
  switch (name) {
    case "fixed":
      return new FixedChunkingStrategy();
    case "paragraph":
      return new ParagraphChunkingStrategy();
    case "markdown":
      return new MarkdownChunkingStrategy();
    case "heading":
      return new HeadingChunkingStrategy();
    case "sentence":
    default:
      return new SentenceChunkingStrategy();
  }
}

/**
 * Infer the best chunking strategy from document structure.
 *
 * Uses markdown chunking when heading markers are present; otherwise sentence chunking.
 *
 * @param text - Document text to inspect.
 * @returns A {@link ChunkingStrategy} suited to the content.
 */
export function inferChunkingStrategy(text: string): ChunkingStrategy {
  if (/^#{1,6}\s/m.test(text)) {
    return new MarkdownChunkingStrategy();
  }
  return new SentenceChunkingStrategy();
}
