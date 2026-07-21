/**
 * Document parsers for the ingest pipeline.
 *
 * Converts files, buffers, and raw text into {@link ParsedDocument} instances
 * before chunking and embedding. Optional peers: `pdf-parse`, `mammoth`.
 *
 * @example
 * ```ts
 * import { resolveParser, loadIngestSource } from "wolbarg/ingest";
 *
 * const source = await loadIngestSource({ path: "./report.pdf" });
 * const parser = resolveParser(source.filename, source.mimeType);
 * const doc = await parser.parse({ buffer: source.buffer, filename: source.filename });
 * ```
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ConfigurationError } from "../errors/index.js";

/** Normalized output from a document parser. */
export interface ParsedDocument {
  /** Extracted plain text (empty for image-only sources). */
  text: string;
  /** Detected or declared MIME type. */
  mimeType: string;
  /** Original filename when known. */
  filename?: string;
  /** Whether the source is a raster image requiring OCR/vision. */
  isImage: boolean;
  /** Raw image bytes when `isImage` is true. */
  imageBuffer?: Buffer;
}

/**
 * Contract for document parsers.
 *
 * Implement this interface to add HTML, EPUB, or proprietary format support.
 * Register custom parsers in the array passed to {@link resolveParser}.
 *
 * @example Custom parser
 * ```ts
 * const htmlParser: DocumentParserProvider = {
 *   name: "html",
 *   extensions: [".html"],
 *   async parse({ buffer }) {
 *     return { text: buffer.toString("utf8"), mimeType: "text/html", isImage: false };
 *   },
 * };
 * ```
 */
export interface DocumentParserProvider {
  /** Parser identifier. */
  readonly name: string;
  /** File extensions this parser handles (lowercase, with dot). */
  readonly extensions: string[];
  /**
   * Parse a document buffer into text and optional image payload.
   * @param input - Buffer plus optional filename and MIME hints.
   */
  parse(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
  }): Promise<ParsedDocument>;
}

function extOf(filename?: string): string {
  if (!filename) {
    return "";
  }
  return path.extname(filename).toLowerCase();
}

export class TextParser implements DocumentParserProvider {
  readonly name = "text";
  readonly extensions = [".txt", ".md", ".markdown", ".csv", ".json"];

  async parse(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
  }): Promise<ParsedDocument> {
    const ext = extOf(input.filename);
    let text = input.buffer.toString("utf8");
    if (ext === ".json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // keep raw
      }
    }
    return {
      text,
      mimeType: input.mimeType ?? "text/plain",
      filename: input.filename,
      isImage: false,
    };
  }
}

export class ImageParser implements DocumentParserProvider {
  readonly name = "image";
  readonly extensions = [".png", ".jpg", ".jpeg", ".webp"];

  async parse(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
  }): Promise<ParsedDocument> {
    const ext = extOf(input.filename);
    const mime =
      input.mimeType ??
      (ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : "image/jpeg");
    return {
      text: "",
      mimeType: mime,
      filename: input.filename,
      isImage: true,
      imageBuffer: input.buffer,
    };
  }
}

export class PdfParser implements DocumentParserProvider {
  readonly name = "pdf";
  readonly extensions = [".pdf"];

  async parse(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
  }): Promise<ParsedDocument> {
    try {
      const mod = await import("pdf-parse");
      // pdf-parse v1: default export is (buffer) => Promise<{ text }>
      // pdf-parse v2: named PDFParse class
      const maybeClass = (mod as { PDFParse?: new (opts: { data: Buffer }) => {
        getText: () => Promise<{ text: string }>;
        destroy?: () => Promise<void>;
      } }).PDFParse;
      let text = "";
      if (typeof maybeClass === "function") {
        const parser = new maybeClass({ data: input.buffer });
        try {
          const result = await parser.getText();
          text = result.text ?? "";
        } finally {
          await parser.destroy?.();
        }
      } else {
        const pdfParse =
          (mod as { default?: (buf: Buffer) => Promise<{ text: string }> }).default ??
          (mod as unknown as (buf: Buffer) => Promise<{ text: string }>);
        if (typeof pdfParse !== "function") {
          throw new Error("pdf-parse export is not a function");
        }
        const result = await pdfParse(input.buffer);
        text = result.text ?? "";
      }
      return {
        text,
        mimeType: "application/pdf",
        filename: input.filename,
        isImage: false,
      };
    } catch (error) {
      if (
        error instanceof ConfigurationError
      ) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigurationError(
        `PDF ingest failed (${detail}). Install compatible pdf-parse: npm install pdf-parse@1.1.4`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }
}

export class DocxParser implements DocumentParserProvider {
  readonly name = "docx";
  readonly extensions = [".docx"];

  async parse(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
  }): Promise<ParsedDocument> {
    let mod: unknown;
    try {
      mod = await import("mammoth" as string);
    } catch (error) {
      throw new ConfigurationError(
        'DOCX ingest requires the optional peer package "mammoth". Install it with: npm install mammoth',
        {
          cause: error instanceof Error ? error : undefined,
          suggestion: "npm install mammoth",
          operation: "parse",
        },
      );
    }

    const extractRawText =
      (mod as {
        extractRawText?: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
      }).extractRawText ??
      (mod as {
        default?: {
          extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
        };
      }).default?.extractRawText;

    if (!extractRawText) {
      throw new ConfigurationError(
        "DOCX ingest could not find mammoth.extractRawText. Ensure your mammoth version is compatible.",
        { operation: "parse" },
      );
    }

    try {
      const result = await extractRawText({ buffer: input.buffer });
      return {
        text: result.value ?? "",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: input.filename,
        isImage: false,
      };
    } catch (error) {
      throw new ConfigurationError(
        "DOCX ingest failed to parse the document (it may be corrupt or an unsupported .docx).",
        {
          cause: error instanceof Error ? error : undefined,
          suggestion: "Try a different DOCX file or ensure it is not password-protected.",
          operation: "parse",
        },
      );
    }
  }
}

/** Built-in parsers tried by {@link resolveParser} in order. */
const DEFAULT_PARSERS: DocumentParserProvider[] = [
  new TextParser(),
  new ImageParser(),
  new PdfParser(),
  new DocxParser(),
];

/**
 * Pick a parser by file extension or MIME type.
 *
 * @param filename - Original filename (used for extension lookup).
 * @param mimeType - Optional MIME fallback when extension is unknown.
 * @param parsers - Parser list (defaults to {@link DEFAULT_PARSERS}).
 * @returns Matching {@link DocumentParserProvider} (text parser as final fallback).
 */
export function resolveParser(
  filename?: string,
  mimeType?: string,
  parsers: DocumentParserProvider[] = DEFAULT_PARSERS,
): DocumentParserProvider {
  const ext = extOf(filename);
  if (ext) {
    const byExt = parsers.find((p) => p.extensions.includes(ext));
    if (byExt) {
      return byExt;
    }
  }
  if (mimeType?.startsWith("image/")) {
    return parsers.find((p) => p.name === "image") ?? new ImageParser();
  }
  if (mimeType === "application/pdf") {
    return parsers.find((p) => p.name === "pdf") ?? new PdfParser();
  }
  return parsers.find((p) => p.name === "text") ?? new TextParser();
}

/**
 * Load ingest input from path, buffer, or inline text.
 *
 * @param source - Exactly one of `path`, `buffer`, or `text` must be provided.
 * @returns Normalized buffer, filename, MIME, and optional raw text.
 * @throws {@link ConfigurationError} when no source field is set.
 *
 * @example
 * ```ts
 * const { buffer, filename } = await loadIngestSource({ path: "./notes.md" });
 * ```
 */
export async function loadIngestSource(source: {
  path?: string;
  buffer?: Buffer;
  text?: string;
  filename?: string;
  mimeType?: string;
}): Promise<{ buffer: Buffer; filename?: string; mimeType?: string; rawText?: string }> {
  if (source.text !== undefined) {
    return {
      buffer: Buffer.from(source.text, "utf8"),
      filename: source.filename ?? "document.txt",
      mimeType: source.mimeType ?? "text/plain",
      rawText: source.text,
    };
  }
  if (source.buffer) {
    return {
      buffer: source.buffer,
      filename: source.filename,
      mimeType: source.mimeType,
    };
  }
  if (source.path) {
    const buffer = await fs.readFile(source.path);
    return {
      buffer,
      filename: path.basename(source.path),
      mimeType: source.mimeType,
    };
  }
  throw new ConfigurationError("ingest source must include path, buffer, or text");
}

/** Default parser chain: text, image, PDF, DOCX. */
export { DEFAULT_PARSERS };
