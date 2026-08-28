import { type DateContext, dates, i18n } from "@k2b/stdlib";
import type { DraftIntent, SenderIdentity } from "../../contracts";
import { deriveReplyAddressObjects } from "../../reply-recipients";
import type { MessageDetail } from "../../service/messages";

type RecipientSeed = { to: string[]; cc: string[] };

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

export const formatMailAddress = (address: { name: string | null; address: string }): string =>
  address.name ? `${address.name} <${address.address}>` : address.address;

export const replySubject = (subject: string): string => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);
export const forwardSubject = (subject: string): string => (/^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`);

export const forwardMessageBody = (message: MessageDetail, dateConfig: DateContext, locale = dateConfig.locale ?? "en"): string => {
  const { t } = mailComposeDerivationMessages.resolve([locale]);
  const localizedDateConfig = { ...dateConfig, locale };
  return `

---------- ${t.forwardedMessage} ----------
${t.from}: ${message.from.map(formatMailAddress).join(", ") || t.unknownSender}
${t.date}: ${dates.formatDateTime(message.internalDate, localizedDateConfig)}
${t.subject}: ${message.subject || t.noSubject}
${t.to}: ${message.to.map(formatMailAddress).join(", ") || t.undisclosedRecipients}

${message.forwardText}`;
};

export const quoteReplyBody = (
  message: MessageDetail,
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

export const deriveReplyIdentityId = (message: MessageDetail, identities: SenderIdentity[]): string | null => {
  const verified = identities.filter((identity) => identity.status === "verified");
  const match = (addresses: Array<{ address: string }>): SenderIdentity[] => {
    const normalized = new Set(addresses.map((item) => item.address.trim().toLowerCase()));
    return verified.filter(
      (identity) =>
        normalized.has(identity.fromAddress.toLowerCase()) || (identity.replyTo ? normalized.has(identity.replyTo.toLowerCase()) : false),
    );
  };
  const recipientMatches = match([...message.to, ...message.cc]);
  const matches = recipientMatches.length > 0 ? recipientMatches : match(message.from);
  if (matches.length === 1) return matches[0]!.id;
  const defaultMatch = matches.find((identity) => identity.isDefault);
  if (defaultMatch) return defaultMatch.id;
  if (matches.length > 1) return null;
  return verified.find((identity) => identity.isDefault)?.id ?? verified[0]?.id ?? null;
};

export const deriveReplyRecipients = (
  message: MessageDetail,
  intent: Extract<DraftIntent, "reply" | "reply_all">,
  identities: SenderIdentity[],
): RecipientSeed => {
  const recipients = deriveReplyAddressObjects(message, intent, identities);
  return {
    to: recipients.to.map((item) => item.address),
    cc: recipients.cc.map((item) => item.address),
  };
};
