/**
 * Optional OCR providers — extract text from images during ingest.
 *
 * OCR is used when ingesting image files without accompanying text. Install the
 * optional peer `tesseract.js` before calling {@link tesseract}.
 *
 * @example
 * ```ts
 * import { tesseract } from "wolbarg/ocr";
 *
 * const ocr = tesseract();
 * const { text } = await ocr.recognize(imageBuffer, "image/png");
 * ```
 */

import { ConfigurationError } from "../errors/index.js";

/** Result of optical character recognition on an image. */
export interface OcrResult {
  /** Extracted plain text (may be empty if OCR finds nothing). */
  text: string;
}

/**
 * Contract for OCR backends.
 *
 * Implement this interface to plug in Google Vision, Azure OCR, or another engine.
 * Wolbarg calls {@link OCRProvider.recognize} during ingest when a document parser
 * marks the source as an image.
 *
 * @example Custom provider
 * ```ts
 * const myOcr: OCRProvider = {
 *   name: "cloud-ocr",
 *   async recognize(image, mimeType) {
 *     const text = await callMyApi(image, mimeType);
 *     return { text };
 *   },
 * };
 * ```
 */
export interface OCRProvider {
  /** Provider identifier (e.g. `"tesseract"`, `"cloud-ocr"`). */
  readonly name: string;
  /**
   * Extract text from a raster image buffer.
   * @param image - Raw image bytes.
   * @param mimeType - Optional MIME hint (e.g. `"image/png"`).
   * @returns Recognized text.
   */
  recognize(image: Buffer, mimeType?: string): Promise<OcrResult>;
}

/**
 * Tesseract.js OCR adapter.
 *
 * Requires the optional peer package `tesseract.js`. Throws
 * {@link ConfigurationError} with install instructions when the peer is missing.
 *
 * @returns An {@link OCRProvider} using English (`"eng"`) by default.
 *
 * @example
 * ```ts
 * // npm install tesseract.js
 * const ocr = tesseract();
 * const result = await ocr.recognize(buffer);
 * ```
 */
export function tesseract(): OCRProvider {
  return {
    name: "tesseract",
    async recognize(image: Buffer): Promise<OcrResult> {
      let mod: unknown;
      try {
        mod = await import("tesseract.js" as string);
      } catch (error) {
        throw new ConfigurationError(
          'OCR provider "tesseract" requires the optional peer package "tesseract.js". Install it with: npm install tesseract.js',
          {
            cause: error instanceof Error ? error : undefined,
            suggestion: 'npm install tesseract.js',
            operation: "recognize",
          },
        );
      }

      const createWorker =
        (mod as { createWorker?: (lang: string) => Promise<{
          recognize: (img: Buffer) => Promise<{ data: { text: string } }>;
          terminate: () => Promise<void>;
        }> }).createWorker ??
        (mod as { default?: { createWorker: (lang: string) => Promise<{
          recognize: (img: Buffer) => Promise<{ data: { text: string } }>;
          terminate: () => Promise<void>;
        }> } }).default?.createWorker;

      if (!createWorker) {
        throw new ConfigurationError(
          'OCR provider "tesseract" could not find tesseract.js.createWorker. Ensure your tesseract.js version is compatible.',
        );
      }

      const worker = await createWorker("eng");
      try {
        const result = await worker.recognize(image);
        return { text: result.data.text.trim() };
      } finally {
        await worker.terminate();
      }
    },
  };
}
