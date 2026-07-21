/**
 * Conversation → memory helpers for {@link Wolbarg.rememberFromMessages}.
 * Experimental until 1.0 — keep extraction thin; apps own richer pipelines.
 */

import type { ChatMessage } from "../llm/index.js";
import type {
  ConversationMessage,
  MemoryDedupeConfig,
  MemoryMetadata,
  RememberFromMessagesOptions,
  RememberFromMessagesRawStrategy,
} from "../types/index.js";
import { ValidationError } from "../errors/index.js";

const DEFAULT_RAW_STRATEGY: RememberFromMessagesRawStrategy = "last_user";

/** Normalize and validate incoming chat messages. */
export function normalizeConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  if (!Array.isArray(messages)) {
    throw new ValidationError("messages must be an array");
  }
  if (messages.length === 0) {
    throw new ValidationError("messages must be a non-empty array");
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new ValidationError(`messages[${index}] must be an object`);
    }
    if (typeof message.role !== "string" || message.role.trim().length === 0) {
      throw new ValidationError(`messages[${index}].role must be a non-empty string`);
    }
    if (typeof message.content !== "string") {
      throw new ValidationError(`messages[${index}].content must be a string`);
    }
    return {
      role: message.role.trim(),
      content: message.content.trim(),
    };
  });
}

export function resolveRememberFromMessagesOptions(
  options: RememberFromMessagesOptions,
): {
  agent: string;
  mode: "raw" | "extract";
  rawStrategy: RememberFromMessagesRawStrategy;
  metadata?: MemoryMetadata;
  dedupe?: boolean | MemoryDedupeConfig;
} {
  if (!options || typeof options !== "object") {
    throw new ValidationError("options is required");
  }
  if (typeof options.agent !== "string" || options.agent.trim().length === 0) {
    throw new ValidationError("agent must be a non-empty string");
  }

  const mode = options.mode ?? "raw";
  if (mode !== "raw" && mode !== "extract") {
    throw new ValidationError('mode must be "raw" or "extract"');
  }

  const rawStrategy = options.rawStrategy ?? DEFAULT_RAW_STRATEGY;
  if (rawStrategy !== "last_user" && rawStrategy !== "all_user") {
    throw new ValidationError('rawStrategy must be "last_user" or "all_user"');
  }

  return {
    agent: options.agent.trim(),
    mode,
    rawStrategy,
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(options.dedupe !== undefined ? { dedupe: options.dedupe } : {}),
  };
}

/** Select user texts to store in `mode: "raw"`. */
export function selectRawUserTexts(
  messages: ConversationMessage[],
  strategy: RememberFromMessagesRawStrategy,
): string[] {
  const userTexts = messages
    .filter((m) => m.role === "user" && m.content.length > 0)
    .map((m) => m.content);

  if (userTexts.length === 0) {
    throw new ValidationError(
      'no user messages with non-empty content — nothing to remember in mode "raw"',
    );
  }

  if (strategy === "last_user") {
    return [userTexts[userTexts.length - 1]!];
  }
  return userTexts;
}

/** Build the fixed experimental extract prompt. */
export function buildExtractMessages(
  messages: ConversationMessage[],
): ChatMessage[] {
  const transcript = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  return [
    {
      role: "system",
      content:
        "Extract durable factual memories from the conversation. " +
        "Return only atomic facts, one per line. " +
        "No numbering, bullets, or commentary. " +
        "If there are no facts worth storing, reply with exactly NONE.",
    },
    {
      role: "user",
      content: transcript,
    },
  ];
}

/** Parse LLM extract output into fact strings. */
export function parseExtractedFacts(llmOutput: string): string[] {
  const trimmed = llmOutput.trim();
  if (trimmed.length === 0 || /^none$/i.test(trimmed)) {
    return [];
  }

  const facts: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    let fact = line.trim();
    if (fact.length === 0) continue;
    fact = fact.replace(/^[-*•]\s+/, "");
    fact = fact.replace(/^\d+[.)]\s+/, "");
    if (fact.length === 0 || /^none$/i.test(fact)) continue;
    facts.push(fact);
  }
  return facts;
}
