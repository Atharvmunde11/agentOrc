/**
 * Optional OCR provider — extract text from images.
 */

import { ConfigurationError } from "../errors/index.js";

export interface OcrResult {
  text: string;
}

export interface OCRProvider {
  readonly name: string;
  recognize(image: Buffer, mimeType?: string): Promise<OcrResult>;
}

/**
 * Placeholder Tesseract adapter.
 * Requires optional peer packages (`tesseract.js`) when used.
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
