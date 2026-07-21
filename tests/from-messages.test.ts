/**
 * rememberFromMessages — experimental conversation → memory bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Wolbarg,
  ProviderNotConfiguredError,
  ValidationError,
} from "../src/index.js";
import {
  createInitializedClient,
  baseInitOptions,
  installFetchMock,
} from "./helpers.js";
import {
  parseExtractedFacts,
  selectRawUserTexts,
  normalizeConversationMessages,
} from "../src/memory/from-messages.js";

describe("from-messages helpers", () => {
  it("selectRawUserTexts last_user returns only the trailing user turn", () => {
    const texts = selectRawUserTexts(
      normalizeConversationMessages([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ]),
      "last_user",
    );
    expect(texts).toEqual(["second"]);
  });

  it("selectRawUserTexts all_user returns every user turn", () => {
    const texts = selectRawUserTexts(
      normalizeConversationMessages([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ]),
      "all_user",
    );
    expect(texts).toEqual(["a", "c"]);
  });

  it("parseExtractedFacts strips bullets and skips NONE", () => {
    expect(parseExtractedFacts("NONE")).toEqual([]);
    expect(
      parseExtractedFacts("- Prefers dark mode\n1. Lives in Berlin\n\n"),
    ).toEqual(["Prefers dark mode", "Lives in Berlin"]);
  });
});

describe("Wolbarg.rememberFromMessages", () => {
  let client: Wolbarg;

  beforeEach(async () => {
    client = await createInitializedClient();
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
  });

  it("raw mode stores the last user message by default", async () => {
    const results = await client.rememberFromMessages(
      [
        { role: "user", content: "I prefer dark mode" },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Also deploy on Fridays" },
      ],
      { agent: "assistant" },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.content.text).toBe("Also deploy on Fridays");
    expect(results[0]!.action).toBe("created");
  });

  it("raw mode all_user stores every user turn", async () => {
    const results = await client.rememberFromMessages(
      [
        { role: "user", content: "Fact one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Fact two" },
      ],
      { agent: "assistant", mode: "raw", rawStrategy: "all_user" },
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content.text)).toEqual([
      "Fact one",
      "Fact two",
    ]);
  });

  it("extract mode requires llm", async () => {
    await client.close();
    installFetchMock();
    client = new Wolbarg();
    const opts = baseInitOptions();
    delete (opts as { llm?: unknown }).llm;
    await client.init(opts);

    await expect(
      client.rememberFromMessages(
        [{ role: "user", content: "I live in Paris" }],
        { agent: "assistant", mode: "extract" },
      ),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("extract mode remembers parsed facts from llm", async () => {
    await client.close();
    client = await createInitializedClient(undefined, {
      summaryText: "- User lives in Paris\n- Prefers tea",
    });

    const results = await client.rememberFromMessages(
      [
        { role: "user", content: "I live in Paris and prefer tea." },
        { role: "assistant", content: "Got it." },
      ],
      { agent: "assistant", mode: "extract" },
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content.text)).toEqual([
      "User lives in Paris",
      "Prefers tea",
    ]);
  });

  it("extract mode returns empty when llm says NONE", async () => {
    await client.close();
    client = await createInitializedClient(undefined, {
      summaryText: "NONE",
    });

    const results = await client.rememberFromMessages(
      [{ role: "user", content: "hello" }],
      { agent: "assistant", mode: "extract" },
    );
    expect(results).toEqual([]);
  });

  it("rejects empty messages", async () => {
    await expect(
      client.rememberFromMessages([], { agent: "assistant" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
