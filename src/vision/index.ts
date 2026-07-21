/**
 * Optional vision providers — captions, descriptions, and entities from images.
 *
 * Vision analysis enriches image ingest when OCR alone is insufficient. Both
 * {@link openaiVision} and {@link geminiVision} use OpenAI-compatible chat
 * endpoints with multimodal messages.
 *
 * @example
 * ```ts
 * import { openaiVision } from "wolbarg/vision";
 *
 * const vision = openaiVision({ apiKey: process.env.OPENAI_API_KEY! });
 * const result = await vision.analyze(imageBuffer, "image/jpeg");
 * console.log(result.caption, result.entities);
 * ```
 */

/** Structured output from a vision analysis call. */
export interface VisionResult {
  /** Short one-line caption. */
  caption: string;
  /** Longer natural-language description. */
  description: string;
  /** Named entities or objects detected in the image. */
  entities: string[];
}

/**
 * Contract for vision / multimodal analysis backends.
 *
 * Implement this interface to plug in Claude, local VLMs, or custom APIs.
 * Wolbarg merges vision output into ingest metadata when processing images.
 *
 * @example Custom provider
 * ```ts
 * const myVision: VisionProvider = {
 *   name: "my-vlm",
 *   async analyze(image, mimeType) {
 *     return { caption: "...", description: "...", entities: ["cat"] };
 *   },
 * };
 * ```
 */
export interface VisionProvider {
  /** Provider identifier (e.g. `"openai-vision"`, `"gemini"`). */
  readonly name: string;
  /**
   * Analyze an image and return structured caption data.
   * @param image - Raw image bytes.
   * @param mimeType - MIME type for the data URL (default `"image/png"`).
   */
  analyze(image: Buffer, mimeType?: string): Promise<VisionResult>;
}

interface VisionHttpOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** Internal OpenAI-compatible multimodal chat vision adapter. */
class OpenAICompatibleVisionProvider implements VisionProvider {
  readonly name: string;
  private readonly options: VisionHttpOptions;

  constructor(options: VisionHttpOptions) {
    this.name = options.name;
    this.options = options;
  }

  async analyze(image: Buffer, mimeType = "image/png"): Promise<VisionResult> {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const url = `${base}/chat/completions`;
    const dataUrl = `data:${mimeType};base64,${image.toString("base64")}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60_000,
    );
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'Describe this image. Reply as JSON: {"caption":"...","description":"...","entities":["..."]}',
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content ?? "";
      return parseVisionJson(content);
    } catch {
      return { caption: "", description: "", entities: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse JSON (or plain text fallback) from model output into {@link VisionResult}. */
function parseVisionJson(content: string): VisionResult {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return { caption: content.trim(), description: content.trim(), entities: [] };
    }
    const parsed = JSON.parse(match[0]) as Partial<VisionResult>;
    return {
      caption: String(parsed.caption ?? ""),
      description: String(parsed.description ?? ""),
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map(String)
        : [],
    };
  } catch {
    return { caption: content.trim(), description: content.trim(), entities: [] };
  }
}

/**
 * Google Gemini vision via the OpenAI-compatible Generative Language API.
 *
 * @param options - API credentials and model selection.
 * @param options.apiKey - Gemini API key.
 * @param options.model - Model id (default `"gemini-2.0-flash"`).
 * @param options.baseUrl - Override API base (default Google OpenAI-compat endpoint).
 * @param options.timeoutMs - Request timeout in milliseconds (default `60000`).
 * @returns A {@link VisionProvider} instance.
 */
export function geminiVision(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): VisionProvider {
  return new OpenAICompatibleVisionProvider({
    name: "gemini",
    baseUrl:
      options.baseUrl ??
      "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: options.apiKey,
    model: options.model ?? "gemini-2.0-flash",
    timeoutMs: options.timeoutMs,
  });
}

/**
 * OpenAI vision via `/chat/completions` with image_url content parts.
 *
 * @param options - API credentials and model selection.
 * @param options.apiKey - OpenAI API key.
 * @param options.model - Vision-capable model (default `"gpt-4o-mini"`).
 * @param options.baseUrl - Override API base (default `"https://api.openai.com/v1"`).
 * @param options.timeoutMs - Request timeout in milliseconds (default `60000`).
 * @returns A {@link VisionProvider} instance.
 *
 * @example
 * ```ts
 * const vision = openaiVision({ apiKey: process.env.OPENAI_API_KEY! });
 * ```
 */
export function openaiVision(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): VisionProvider {
  return new OpenAICompatibleVisionProvider({
    name: "openai-vision",
    baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
    apiKey: options.apiKey,
    model: options.model ?? "gpt-4o-mini",
    timeoutMs: options.timeoutMs,
  });
}
