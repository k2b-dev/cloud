import { describe, expect, spyOn, test } from "bun:test";
import { markdown } from "../shared";
import { AI_DRAFT_QUOTE_MAX_ITEMS, AI_MESSAGE_SEARCH_TEXT_MAX_CHARS } from "./limits";
import { aiQuoteModelText } from "./quote-markers";
import { AiQuoteError, resolveAiQuotes } from "./quote-sources";
import type { AiQuoteSourceRow } from "./types";

type Quoted = Extract<AiQuoteSourceRow, { part: "quoted" }>;
const quoted = (shortId: string, role: string, options: Partial<Quoted> = {}): Quoted => ({
  part: "quoted",
  shortId,
  role,
  loopId: null,
  message: null,
  automation: false,
  ...options,
});
const user = (shortId: string, text: string, options: Partial<Quoted> = {}) =>
  quoted(shortId, "user", { message: { role: "user", content: [{ type: "text", text }] }, ...options });
const answer = (key: string, text: string): AiQuoteSourceRow => ({ part: "answer", key, text });

/** A store that answers with `rows` and records which ids each lookup asked for. */
const storeOf = (rows: AiQuoteSourceRow[]) => {
  const asked: string[][] = [];
  return {
    asked,
    listQuoteSources: async (input: { conversationId: string; messageIds: readonly string[] }) => {
      asked.push([...input.messageIds]);
      return rows;
    },
  };
};

describe("checked quotes", () => {
  const turn = [
    quoted("Ans001", "assistant", { loopId: "turn-1" }),
    answer("turn-1", "Der **Stromanschluss** mit 3 kW ist im Angebot enthalten."),
  ];
  const own = user("Own001", "Was steht im Angebot zu Strom und Internet?");
  const automation = user("Aut001", "Lieferavise heute prüfen", { automation: true });

  test("whose words a quote are comes from its message, never from the client", async () => {
    const store = storeOf([...turn, own, automation]);
    const quotes = await resolveAiQuotes(
      "chat",
      [
        // The client claims the person wrote Gustav's answer, and the other way round.
        { messageId: "Ans001", from: "user", text: "Stromanschluss mit 3 kW" },
        { messageId: "Own001", from: "assistant", text: "Strom und Internet" },
        { messageId: "Aut001", from: "user", text: "Lieferavise heute" },
      ],
      store,
    );
    expect(quotes).toEqual([
      { messageId: "Ans001", from: "assistant", text: "Stromanschluss mit 3 kW" },
      { messageId: "Own001", from: "user", text: "Strom und Internet" },
      { messageId: "Aut001", from: "automation", text: "Lieferavise heute" },
    ]);
    // One lookup for all quotes of the message.
    expect(store.asked).toEqual([["Ans001", "Own001", "Aut001"]]);
  });

  test("a passage stands in the answer as the reader sees it, whitespace aside", async () => {
    const quotes = await resolveAiQuotes("chat", [{ messageId: "Ans001", text: "Stromanschluss\n mit 3  kW ist" }], storeOf(turn));
    expect(quotes[0]!.from).toBe("assistant");
    // The Markdown source is no passage a reader saw.
    await expect(resolveAiQuotes("chat", [{ messageId: "Ans001", text: "**Stromanschluss**" }], storeOf(turn))).rejects.toThrow(
      AiQuoteError,
    );
  });

  test("an answer whose text spans several messages of its turn is one passage source", async () => {
    const rows = [
      quoted("Ans102", "assistant", { loopId: "turn-2" }),
      answer("turn-2", "Der Aufbau ist ab Samstag möglich."),
      answer("turn-2", "Der Abbau beginnt am letzten Tag."),
    ];
    const quotes = await resolveAiQuotes("chat", [{ messageId: "Ans102", text: "ab Samstag möglich. Der Abbau beginnt" }], storeOf(rows));
    expect(quotes).toEqual([{ messageId: "Ans102", from: "assistant", text: "ab Samstag möglich. Der Abbau beginnt" }]);
  });

  test("a sentence Gustav never said, a message of another chat, or a tool result is no quote", async () => {
    const store = storeOf([...turn, quoted("Tool01", "tool_result")]);
    await expect(resolveAiQuotes("chat", [{ messageId: "Ans001", text: "Strom ist kostenlos" }], store)).rejects.toThrow(
      "does not match its message",
    );
    await expect(resolveAiQuotes("chat", [{ messageId: "Else01", text: "Stromanschluss" }], store)).rejects.toThrow("not in this chat");
    await expect(resolveAiQuotes("chat", [{ messageId: "Tool01", text: "secret" }], store)).rejects.toThrow("Only answers and messages");
  });

  test("a message that quotes earlier text has only its own words as a passage", async () => {
    const checked = { messageId: "Ans001", from: "assistant" as const, text: "Stromanschluss" };
    const quoting = quoted("Own002", "user", {
      message: {
        role: "user",
        content: [
          { type: "text", text: "Und das Internet?" },
          { type: "text", text: aiQuoteModelText(checked) },
        ],
      },
      quotes: [checked],
    });
    // Its stored model text for the quote is no passage of the person's own.
    await expect(resolveAiQuotes("chat", [{ messageId: "Own002", text: "Stromanschluss" }], storeOf([quoting]))).rejects.toThrow(
      AiQuoteError,
    );
    expect(await resolveAiQuotes("chat", [{ messageId: "Own002", text: "das Internet" }], storeOf([quoting]))).toEqual([
      { messageId: "Own002", from: "user", text: "das Internet" },
    ]);
  });

  test("ten quotes of one turn read and render the turn once", async () => {
    const sentences = Array.from({ length: AI_DRAFT_QUOTE_MAX_ITEMS }, (_, index) => `Satz ${index} steht hier.`);
    const store = storeOf([quoted("Ans201", "assistant", { loopId: "turn-3" }), ...sentences.map((text) => answer("turn-3", text))]);
    const render = spyOn(markdown, "renderSync");
    try {
      const quotes = await resolveAiQuotes(
        "chat",
        sentences.map((text) => ({ messageId: "Ans201", text })),
        store,
      );
      expect(quotes).toHaveLength(AI_DRAFT_QUOTE_MAX_ITEMS);
      expect(render).toHaveBeenCalledTimes(1);
      expect(store.asked).toEqual([["Ans201"]]);
    } finally {
      render.mockRestore();
    }
  });

  test("an answer longer than the text Cloud keeps of a message is refused with that cause, before rendering", async () => {
    const half = "a".repeat(AI_MESSAGE_SEARCH_TEXT_MAX_CHARS / 2);
    const store = storeOf([
      quoted("Ans301", "assistant", { loopId: "turn-4" }),
      answer("turn-4", `Anfang ${half}`),
      answer("turn-4", half),
    ]);
    const render = spyOn(markdown, "renderSync");
    try {
      await expect(resolveAiQuotes("chat", [{ messageId: "Ans301", text: "Anfang" }], store)).rejects.toThrow(
        `An answer longer than ${AI_MESSAGE_SEARCH_TEXT_MAX_CHARS} characters cannot be quoted.`,
      );
      expect(render).not.toHaveBeenCalled();
    } finally {
      render.mockRestore();
    }
  });
});
