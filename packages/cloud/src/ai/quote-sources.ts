import { markdown } from "../shared";
import { userVisibleTextFromMessage } from "./chat/message-utils";
import { type AiMessageQuote, type AiQuoteDraft, aiQuoteStandsIn, aiQuoteVisibleTextOfHtml } from "./quote-markers";
import type { AiQuoteSourceRow } from "./types";

/** Why the server cannot vouch for a quote; a stable code the route turns into the person's message. */
export type AiQuoteErrorReason = "missing" | "not_quotable" | "mismatch" | "too_long";

/** A quote the server cannot vouch for: nothing is sent, and the person hears why in their language. */
export class AiQuoteError extends Error {
  constructor(readonly reason: AiQuoteErrorReason) {
    super(`quote_${reason}`);
  }
}

/**
 * The draft's quotes as checked quotes: each names a message of this conversation, its passage stands in that message's
 * visible text (compared without whitespace), and `from` comes from the message, never from the client. An answer is
 * read as rendered Markdown across its turn, and each turn is read and rendered once, whatever its quotes.
 */
export const resolveAiQuotes = async (
  conversationId: string,
  drafts: readonly AiQuoteDraft[],
  store: { listQuoteSources(input: { conversationId: string; messageIds: readonly string[] }): Promise<AiQuoteSourceRow[]> },
): Promise<AiMessageQuote[]> => {
  if (drafts.length === 0) return [];
  const rows = await store.listQuoteSources({ conversationId, messageIds: [...new Set(drafts.map((draft) => draft.messageId))] });
  // The text parts of each answer by message, in order; an answer over the bound arrives as one row without text.
  const answers = new Map<string, Map<number, string[]>>();
  const over = new Set<string>();
  for (const row of rows) {
    if (row.part === "over") over.add(row.key);
    if (row.part !== "answer") continue;
    const messages = answers.get(row.key) ?? new Map<number, string[]>();
    answers.set(row.key, messages);
    const parts = messages.get(row.seq);
    if (parts) parts.push(row.text);
    else messages.set(row.seq, [row.text]);
  }
  const visible = new Map<string, string>();
  const answerText = (key: string): string => {
    let text = visible.get(key);
    if (text === undefined) {
      const messages = [...(answers.get(key)?.values() ?? [])].map((parts) => parts.join(""));
      text = aiQuoteVisibleTextOfHtml(markdown.renderSync(messages.join("\n\n")));
      visible.set(key, text);
    }
    return text;
  };
  return drafts.map((draft) => {
    const entry = rows.find((row) => row.part === "quoted" && row.shortId === draft.messageId);
    if (!entry || entry.part !== "quoted") throw new AiQuoteError("missing");
    let source: { from: AiMessageQuote["from"]; text: string };
    if (entry.role === "user" && entry.message) {
      source = { from: entry.automation ? "automation" : "user", text: userVisibleTextFromMessage(entry.message, entry.quotes) };
    } else if (entry.role === "assistant") {
      const key = entry.loopId ?? entry.shortId;
      if (over.has(key)) throw new AiQuoteError("too_long");
      source = { from: "assistant", text: answerText(key) };
    } else {
      throw new AiQuoteError("not_quotable");
    }
    if (!aiQuoteStandsIn(draft.text, source.text)) throw new AiQuoteError("mismatch");
    return { messageId: draft.messageId, from: source.from, text: draft.text };
  });
};
