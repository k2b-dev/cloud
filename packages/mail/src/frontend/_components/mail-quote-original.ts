import { type DateContext, dates } from "@k2b/stdlib";
import { messageForwardTextOf } from "../../forward-text";
import type { MailQuoteOriginal } from "./MailQuoteCard";

/**
 * The quoted message as the reply's card shows it: the sender, the date, and the readable text the send renderer quotes
 * (plain text, or the text form of an HTML message).
 */
export const quoteOriginalOf = (
  message: { from: { name: string | null; address: string }[]; internalDate: string; plainText: string | null; forwardText?: string },
  dateConfig: DateContext,
): MailQuoteOriginal => {
  const sender = message.from[0];
  return {
    name: sender?.name || sender?.address || "",
    date: dates.formatDateTimeRelative(message.internalDate, dateConfig),
    text: messageForwardTextOf(message),
  };
};
