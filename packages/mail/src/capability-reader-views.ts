import type { BlockView } from "@k2b/cloud/blocks";
import { dates, i18n } from "@k2b/stdlib";

/**
 * What a person sees of a message or a conversation where Cloud shows a reader's view: the search preview and a
 * capability result in the chat. Gustav keeps reading `data`; these blocks only present it. Message text stays
 * untrusted plain text: it is shown as text, never as markup or links.
 */
const readerViewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      message: "Message",
      conversation: "Conversation",
      from: "From",
      to: "To",
      date: "Date",
      attachments: "Attachments",
      noText: "This message has no text.",
      textPending: "The text of this message is still loading in Mail.",
      truncated: "Shortened. Open the message in Mail to read all of it.",
      status: "Status",
      assigned: "Assigned to",
      tags: "Tags",
      summary: "Summary",
      latest: "Latest messages",
      sender: "From",
      subject: "Message",
      sent: "Date",
      noSubject: "(no subject)",
      open: "Needs action",
      done: "Done",
      waiting: "Waiting",
      nobody: "Nobody",
      more: "More in Mail",
    },
    de: {
      message: "Nachricht",
      conversation: "Unterhaltung",
      from: "Von",
      to: "An",
      date: "Datum",
      attachments: "Anhänge",
      noText: "Diese Nachricht hat keinen Text.",
      textPending: "Der Text dieser Nachricht wird in Mail noch geladen.",
      truncated: "Gekürzt. Öffne die Nachricht in Mail, um alles zu lesen.",
      status: "Status",
      assigned: "Zuständig",
      tags: "Tags",
      summary: "Zusammenfassung",
      latest: "Neueste Nachrichten",
      sender: "Von",
      subject: "Nachricht",
      sent: "Datum",
      noSubject: "(kein Betreff)",
      open: "Zu bearbeiten",
      done: "Erledigt",
      waiting: "Wartet",
      nobody: "Niemand",
      more: "Weitere in Mail",
    },
  },
});

/** Message text in the view: enough to read the message in the preview, bounded so data and view fit one result. */
export const READER_VIEW_TEXT_BYTES = 16 * 1024;

type Person = { name: string | null; address: string };
type Formatting = { locale?: string; timeZone: string };

const words = (locale?: string) => readerViewMessages.resolve([locale ?? "en"]).t;
const person = (entry: Person) => (entry.name?.trim() ? `${entry.name.trim()} <${entry.address}>` : entry.address);
const people = (entries: readonly Person[], locale?: string) =>
  i18n.formatList(entries.slice(0, 20).map(person), locale ?? "en") + (entries.length > 20 ? ` +${entries.length - 20}` : "");
const when = (value: string, format: Formatting) => dates.formatDateTime(value, { locale: format.locale, timeZone: format.timeZone });
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
/** Cuts at a character boundary within the byte budget. */
const within = (value: string, limit: number): { text: string; cut: boolean } => {
  if (bytes(value) <= limit) return { text: value, cut: false };
  let end = Math.min(value.length, limit);
  while (end > 0 && bytes(value.slice(0, end)) > limit - 3) end = Math.floor(end * 0.9);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return { text: `${value.slice(0, end).trimEnd()}…`, cut: true };
};

export type MessageReaderViewSource = Formatting & {
  from: readonly Person[];
  to: readonly Person[];
  cc: readonly Person[];
  sentAt: string | null;
  internalDate: string;
  attachments: readonly { filename: string | null }[];
  /** Plain text of the message; `null` while Mail still loads it. */
  text: string | null;
  /** Mail already shortened the text it read. */
  textTruncated: boolean;
};

export const messageReaderView = (source: MessageReaderViewSource): BlockView => {
  const t = words(source.locale);
  const body = source.text === null ? null : within(source.text.trim(), READER_VIEW_TEXT_BYTES);
  const attachments = source.attachments.map((entry) => entry.filename?.trim() || "—");
  return {
    version: 1,
    blocks: [
      {
        kind: "Detail",
        title: t.message,
        items: [
          { label: t.from, value: people(source.from, source.locale) || "—" },
          { label: t.to, value: people(source.to, source.locale) || "—" },
          ...(source.cc.length ? [{ label: "Cc", value: people(source.cc, source.locale) }] : []),
          { label: t.date, value: when(source.sentAt ?? source.internalDate, source) },
          ...(attachments.length ? [{ label: t.attachments, value: attachments.slice(0, 50).join("\n") }] : []),
        ],
      },
      ...(body === null
        ? [{ kind: "Notice" as const, tone: "info" as const, title: t.textPending }]
        : body.text
          ? [{ kind: "Text" as const, text: body.text }]
          : [{ kind: "Notice" as const, tone: "info" as const, title: t.noText }]),
      ...(body?.cut || source.textTruncated ? [{ kind: "Notice" as const, tone: "info" as const, title: t.truncated }] : []),
    ],
  };
};

export type ConversationReaderViewSource = Formatting & {
  summary: string | null;
  workStatus: string | null;
  assignees: readonly { displayName: string }[];
  tags: readonly { name: string }[];
  messages: readonly { from: readonly Person[]; subject: string; sentAt: string | null; internalDate: string; preview?: string }[];
  /** More messages exist than `messages` shows. */
  more: boolean;
};

export const conversationReaderView = (source: ConversationReaderViewSource): BlockView => {
  const t = words(source.locale);
  const status = source.workStatus === "done" ? t.done : source.workStatus === "waiting" ? t.waiting : t.open;
  const summary = source.summary?.trim() ? within(source.summary.trim(), 4 * 1024).text : null;
  return {
    version: 1,
    blocks: [
      {
        kind: "Detail",
        title: t.conversation,
        items: [
          { label: t.status, value: status },
          {
            label: t.assigned,
            value: source.assignees.length
              ? i18n.formatList(
                  source.assignees.slice(0, 5).map((entry) => entry.displayName),
                  source.locale ?? "en",
                )
              : t.nobody,
          },
          ...(source.tags.length ? [{ label: t.tags, value: source.tags.map((tag) => tag.name).join(", ") }] : []),
        ],
      },
      ...(summary ? [{ kind: "Section" as const, title: t.summary, children: [{ kind: "Text" as const, text: summary }] }] : []),
      ...(source.messages.length
        ? [
            {
              kind: "Table" as const,
              title: t.latest,
              ...(source.more ? { subtitle: t.more } : {}),
              columns: [
                { path: ["from"], label: t.sender },
                { path: ["subject"], label: t.subject },
                { path: ["sent"], label: t.sent },
              ],
              rows: source.messages.map((message) => ({
                from: message.from.map((entry) => entry.name?.trim() || entry.address).join(", ") || "—",
                subject: within(message.preview?.trim() || message.subject.trim() || t.noSubject, 600).text,
                sent: when(message.sentAt ?? message.internalDate, source),
              })),
            },
          ]
        : []),
    ],
  };
};
