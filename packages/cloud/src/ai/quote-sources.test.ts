import { describe, expect, test } from "bun:test";
import { aiQuoteModelText } from "./quote-markers";
import { AiQuoteError, resolveAiQuotes } from "./quote-sources";
import type { AiStoredMessage } from "./types";

const at = "2026-11-17T08:00:00.000Z";
const stored = (
  shortId: string,
  role: "user" | "assistant" | "tool_result",
  text: string,
  options: { loopId?: string | null; meta?: AiStoredMessage["meta"] } = {},
): AiStoredMessage =>
  ({
    id: shortId,
    shortId,
    conversationId: "chat",
    seq: 1,
    kind: "message",
    message: role === "tool_result" ? { role, callId: "c", name: "tool", result: text } : { role, content: [{ type: "text", text }] },
    loopId: options.loopId ?? null,
    modelId: null,
    providerModel: null,
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: options.meta ?? null,
    createdAt: at,
  }) as AiStoredMessage;

/** A store that knows `messages` and records which ids each lookup asked for. */
const storeOf = (messages: AiStoredMessage[]) => {
  const asked: string[][] = [];
  return {
    asked,
    listQuoteSources: async (input: { conversationId: string; messageIds: readonly string[] }) => {
      asked.push([...input.messageIds]);
      const loops = new Set(messages.filter((entry) => input.messageIds.includes(entry.shortId)).map((entry) => entry.loopId));
      return messages.filter(
        (entry) =>
          input.messageIds.includes(entry.shortId) || (entry.message.role === "assistant" && entry.loopId && loops.has(entry.loopId)),
      );
    },
  };
};

describe("checked quotes", () => {
  const answer = stored("Ans001", "assistant", "Der **Stromanschluss** mit 3 kW ist im Angebot enthalten.", { loopId: "turn-1" });
  const own = stored("Own001", "user", "Was steht im Angebot zu Strom und Internet?");
  const automation = stored("Aut001", "user", "Lieferavise heute prüfen", {
    meta: { codeOrigin: { label: "Automation Lieferavise" } } as unknown as AiStoredMessage["meta"],
  });

  test("whose words a quote are comes from its message, never from the client", async () => {
    const store = storeOf([answer, own, automation]);
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
    const quotes = await resolveAiQuotes("chat", [{ messageId: "Ans001", text: "Stromanschluss\n mit 3  kW ist" }], storeOf([answer]));
    expect(quotes[0]!.from).toBe("assistant");
    // The Markdown source is no passage a reader saw.
    await expect(resolveAiQuotes("chat", [{ messageId: "Ans001", text: "**Stromanschluss**" }], storeOf([answer]))).rejects.toThrow(
      AiQuoteError,
    );
  });

  test("an answer whose text spans several messages of its turn is one passage source", async () => {
    const first = stored("Ans101", "assistant", "Der Aufbau ist ab Samstag möglich.", { loopId: "turn-2" });
    const second = stored("Ans102", "assistant", "Der Abbau beginnt am letzten Tag.", { loopId: "turn-2" });
    const quotes = await resolveAiQuotes(
      "chat",
      [{ messageId: "Ans102", text: "ab Samstag möglich. Der Abbau beginnt" }],
      storeOf([first, second]),
    );
    expect(quotes).toEqual([{ messageId: "Ans102", from: "assistant", text: "ab Samstag möglich. Der Abbau beginnt" }]);
  });

  test("a sentence Gustav never said, a message of another chat, or a tool result is no quote", async () => {
    const store = storeOf([answer, stored("Tool01", "tool_result", "secret")]);
    await expect(resolveAiQuotes("chat", [{ messageId: "Ans001", text: "Strom ist kostenlos" }], store)).rejects.toThrow(
      "does not match its message",
    );
    await expect(resolveAiQuotes("chat", [{ messageId: "Else01", text: "Stromanschluss" }], store)).rejects.toThrow("not in this chat");
    await expect(resolveAiQuotes("chat", [{ messageId: "Tool01", text: "secret" }], store)).rejects.toThrow("Only answers and messages");
  });

  test("a message that quotes earlier text has only its own words as a passage", async () => {
    const quoting = stored("Own002", "user", "Und das Internet?", {
      meta: { quotes: [{ messageId: "Ans001", from: "assistant", text: "Stromanschluss" }] },
    });
    // Its stored model text for the quote is no passage of the person's own.
    quoting.message = {
      role: "user",
      content: [
        { type: "text", text: "Und das Internet?" },
        { type: "text", text: aiQuoteModelText({ messageId: "Ans001", from: "assistant", text: "Stromanschluss" }) },
      ],
    };
    await expect(resolveAiQuotes("chat", [{ messageId: "Own002", text: "Stromanschluss" }], storeOf([quoting]))).rejects.toThrow(
      AiQuoteError,
    );
    expect(await resolveAiQuotes("chat", [{ messageId: "Own002", text: "das Internet" }], storeOf([quoting]))).toEqual([
      { messageId: "Own002", from: "user", text: "das Internet" },
    ]);
  });
});
