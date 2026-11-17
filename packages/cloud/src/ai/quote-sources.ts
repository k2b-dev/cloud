import { markdown } from "../shared";
import { userVisibleTextFromMessage } from "./chat/message-utils";
import { AI_MESSAGE_SEARCH_TEXT_MAX_CHARS } from "./limits";
import { type AiMessageQuote, type AiQuoteDraft, aiQuoteStandsIn, aiQuoteVisibleTextOfHtml } from "./quote-markers";
import type { AiQuoteSourceRow } from "./types";

/** A quote the server cannot vouch for: the person hears why, and nothing is sent. */
export class AiQuoteError extends Error {}

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
  const turns = new Map<string, string[]>();
  for (const row of rows) {
    if (row.part !== "answer") continue;
    const parts = turns.get(row.key);
    if (parts) parts.push(row.text);
    else turns.set(row.key, [row.text]);
  }
  // The text of a turn stops at the bound, so an answer that reaches it may say more than the check could read.
  const visible = new Map<string, string | null>();
  const answerText = (key: string, parts: readonly string[]): string | null => {
    if (!visible.has(key)) {
      const length = parts.reduce((sum, part) => sum + part.length, 0);
      visible.set(
        key,
        length >= AI_MESSAGE_SEARCH_TEXT_MAX_CHARS ? null : aiQuoteVisibleTextOfHtml(markdown.renderSync(parts.join("\n\n"))),
      );
    }
    return visible.get(key) ?? null;
  };
  return drafts.map((draft) => {
    const entry = rows.find((row) => row.part === "quoted" && row.shortId === draft.messageId);
    if (!entry || entry.part !== "quoted")
      throw new AiQuoteError("A quoted message is not in this chat any more. Remove the quote and send again.");
    let source: { from: AiMessageQuote["from"]; text: string };
    if (entry.role === "user" && entry.message) {
      source = { from: entry.automation ? "automation" : "user", text: userVisibleTextFromMessage(entry.message, entry.quotes) };
    } else if (entry.role === "assistant") {
      const key = entry.loopId ?? entry.shortId;
      const text = answerText(key, turns.get(key) ?? []);
      if (text === null)
        throw new AiQuoteError(
          `An answer longer than ${AI_MESSAGE_SEARCH_TEXT_MAX_CHARS} characters cannot be quoted. Remove the quote and send again.`,
        );
      source = { from: "assistant", text };
    } else {
      throw new AiQuoteError("Only answers and messages can be quoted. Remove the quote and send again.");
    }
    if (!aiQuoteStandsIn(draft.text, source.text))
      throw new AiQuoteError("A quote does not match its message any more. Remove the quote and quote it again.");
    return { messageId: draft.messageId, from: source.from, text: draft.text };
  });
};
