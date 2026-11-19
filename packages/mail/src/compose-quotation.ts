import { type DateContext, dates, i18n } from "@k2b/stdlib";
import type { MailAddress } from "./contracts";
import { messageForwardTextOf } from "./forward-text";

type QuoteMessage = {
  from: MailAddress[];
  to: MailAddress[];
  subject: string;
  internalDate: string;
  plainText: string | null;
  forwardText?: string;
};

export const mailComposeDerivationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      forwardedMessage: "Forwarded message",
      from: "From",
      date: "Date",
      subject: "Subject",
      to: "To",
      unknownSender: "Unknown sender",
      noSubject: "(no subject)",
      undisclosedRecipients: "Undisclosed recipients",
      quoteAttribution: ({ date, sender }: { date: string; sender: string }) => `${date} ${sender} wrote:`,
    },
    de: {
      forwardedMessage: "Weitergeleitete Nachricht",
      from: "Von",
      date: "Datum",
      subject: "Betreff",
      to: "An",
      unknownSender: "Unbekannter Absender",
      noSubject: "(kein Betreff)",
      undisclosedRecipients: "Nicht offengelegte Empfänger",
      quoteAttribution: ({ date, sender }) => `Am ${date} schrieb ${sender}:`,
    },
  },
});

export const formatMailAddress = (address: MailAddress): string =>
  address.name ? `${address.name} <${address.address}>` : address.address;

export const replySubject = (subject: string): string => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);
export const forwardSubject = (subject: string): string => (/^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`);

export const forwardMessageBody = (message: QuoteMessage, dateConfig: DateContext, locale = dateConfig.locale ?? "en"): string => {
  const { t } = mailComposeDerivationMessages.resolve([locale]);
  const localizedDateConfig = { ...dateConfig, locale };
  return `

---------- ${t.forwardedMessage} ----------
${t.from}: ${message.from.map(formatMailAddress).join(", ") || t.unknownSender}
${t.date}: ${dates.formatDateTime(message.internalDate, localizedDateConfig)}
${t.subject}: ${message.subject || t.noSubject}
${t.to}: ${message.to.map(formatMailAddress).join(", ") || t.undisclosedRecipients}

${messageForwardTextOf(message)}`;
};

/**
 * Whether a body quotes on its own, as "Quote selection" does: a Markdown quote line or an HTML blockquote outside code
 * blocks. Then the whole original stays out, so nothing goes along twice.
 */
export const bodyQuotes = (body: string): boolean => {
  const prose = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");
  return /^ {0,3}>/m.test(prose) || /<blockquote\b/i.test(prose);
};

/**
 * The quote a reply draft gets when its caller does not choose: a reply or reply all with a source message quotes it,
 * unless the body quotes on its own. An explicit choice, null included, always wins.
 */
export const defaultReplyQuoteSource = <T>(params: {
  quoteSource: T | null | undefined;
  intent: string | undefined;
  sourceMessageId: string | null | undefined;
  body: string;
  quote: () => T;
}): T | null => {
  if (params.quoteSource !== undefined) return params.quoteSource;
  const replies = params.intent === "reply" || params.intent === "reply_all";
  return replies && params.sourceMessageId && !bodyQuotes(params.body) ? params.quote() : null;
};

export const quoteReplyBody = (
  message: QuoteMessage,
  selectedText: string,
  dateConfig: DateContext,
  locale = dateConfig.locale ?? "en",
): string => {
  const { t } = mailComposeDerivationMessages.resolve([locale]);
  const sender = message.from[0]?.name || message.from[0]?.address || t.unknownSender;
  const date = dates.formatDateTime(message.internalDate, { ...dateConfig, locale });
  return `${t.quoteAttribution({ date, sender })}\n${selectedText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
};
