import { markdown } from "../shared";
import { userVisibleTextFromMessage } from "./chat/message-utils";
import { type AiMessageQuote, type AiQuoteDraft, type AiQuoteSource, aiQuoteStandsIn, aiQuoteVisibleTextOfHtml } from "./quote-markers";
import { assistantVisibleTextFromMessage } from "./timeline";
import type { AiStoredMessage } from "./types";

/** A quote the server cannot vouch for: the person hears why, and nothing is sent. */
export class AiQuoteError extends Error {}

/** What a reader sees of `entry` and whose words those are; nothing for a message no one can quote. */
const quoteSource = (entry: AiStoredMessage, all: readonly AiStoredMessage[]): { from: AiQuoteSource; visible: string } | null => {
  if (entry.message.role === "user")
    return {
      from: entry.meta?.codeOrigin ? "automation" : "user",
      visible: userVisibleTextFromMessage(entry.message, entry.meta?.quotes),
    };
  if (entry.message.role !== "assistant") return null;
  // An answer reads as rendered Markdown, and its text can span every assistant message of its turn.
  const turn = all.filter((other) => other.message.role === "assistant" && other.loopId !== null && other.loopId === entry.loopId);
  const text = (turn.length ? turn : [entry]).map((other) => assistantVisibleTextFromMessage(other.message)).join("\n\n");
  return { from: "assistant", visible: aiQuoteVisibleTextOfHtml(markdown.renderSync(text)) };
};

/**
 * The draft's quotes as checked quotes: each names a message of this conversation, its passage stands in that message's
 * visible text (compared without whitespace), and `from` comes from the message, never from the client.
 */
export const resolveAiQuotes = async (
  conversationId: string,
  drafts: readonly AiQuoteDraft[],
  store: { listQuoteSources(input: { conversationId: string; messageIds: readonly string[] }): Promise<AiStoredMessage[]> },
): Promise<AiMessageQuote[]> => {
  if (drafts.length === 0) return [];
  const sources = await store.listQuoteSources({ conversationId, messageIds: [...new Set(drafts.map((draft) => draft.messageId))] });
  return drafts.map((draft) => {
    const entry = sources.find((source) => source.shortId === draft.messageId);
    if (!entry) throw new AiQuoteError("A quoted message is not in this chat any more. Remove the quote and send again.");
    const source = quoteSource(entry, sources);
    if (!source) throw new AiQuoteError("Only answers and messages can be quoted. Remove the quote and send again.");
    if (!aiQuoteStandsIn(draft.text, source.visible))
      throw new AiQuoteError("A quote does not match its message any more. Remove the quote and quote it again.");
    return { messageId: draft.messageId, from: source.from, text: draft.text };
  });
};
