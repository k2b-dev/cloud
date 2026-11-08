import type { BlockView } from "@k2b/cloud/blocks";
import { actionReview } from "@k2b/cloud/capabilities";
import type {
  CapabilityActionCallReview,
  CapabilityActionReceipt,
  CapabilityPerson,
  CapabilitySlot,
  CloudResourceRef,
} from "@k2b/cloud/contracts";
import { CAPABILITY_MAX_REVIEW_BYTES } from "@k2b/cloud/contracts";
import { mailCapabilityMessages } from "./capability-messages";
import { type MailReviewMessage, mailReviewCopy, mailReviewLocale, mailReviewMessages } from "./capability-review-messages";
import type { MailAddress } from "./contracts";

/** Compact text must remain valid Unicode for JSONB, including when a UTF-16 bound cuts an emoji. */
const reviewSlice = (value: string, max: number): string => {
  const before = value.charCodeAt(max - 1);
  const after = value.charCodeAt(max);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return value.slice(0, splitsPair ? max - 1 : max).toWellFormed();
};

/** Review projections have smaller display bounds than the durable Mail objects. */
export const reviewLine = (value: string, max = 200): string => reviewSlice(value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " "), max);
export const reviewObject = (title: string, ref?: CloudResourceRef, icon = "ti ti-mail"): CapabilitySlot => ({
  kind: "object",
  title: reviewLine(title) || "—",
  ...(ref ? { ref: { type: ref.type, id: ref.id } } : {}),
  icon,
});
export const reviewPlace = (title: string, ref?: CloudResourceRef, icon = "ti ti-inbox"): CapabilitySlot => ({
  kind: "place",
  title: reviewLine(title) || "—",
  ...(ref ? { ref: { type: ref.type, id: ref.id } } : {}),
  icon,
});
export const reviewPerson = (person: MailAddress): CapabilityPerson => ({
  ...(person.name?.trim() ? { name: reviewLine(person.name.trim()) } : {}),
  address: reviewLine(person.address, 320),
});
export const reviewPeople = (people: CapabilityPerson[]): Extract<CapabilitySlot, { kind: "person" }> => ({
  kind: "person",
  people: people.slice(0, 20).map((person) => ({
    ...(person.name !== undefined ? { name: reviewLine(person.name) } : {}),
    ...(person.address !== undefined ? { address: reviewLine(person.address, 320) } : {}),
    ...(person.userId !== undefined ? { userId: person.userId } : {}),
  })),
  total: people.length,
});
export const reviewTime = (start: string): CapabilitySlot => ({ kind: "time", start, format: "date-time" });
export const reviewCount = (value: number, locale?: string): CapabilitySlot => ({
  kind: "count",
  value,
  noun:
    mailReviewLocale(locale) === "de" ? { one: "Unterhaltung", other: "Unterhaltungen" } : { one: "conversation", other: "conversations" },
});

/** Fields have no truncation flag: split long identifiers instead of hiding the target. */
export const reviewFieldRows = (label: string, value: string) => {
  const text = reviewLine(value, value.length) || "—";
  const rows: { label: string; value: string }[] = [];
  for (let offset = 0; offset < text.length; ) {
    const value = reviewSlice(text.slice(offset), 2000);
    rows.push({ label: reviewLine(rows.length ? `${label} (${rows.length + 1})` : label, 60), value });
    offset += value.length;
  }
  return rows;
};

export type MailReviewOptions = Omit<CapabilityActionCallReview, "locale" | "sentence" | "slots">;
const fixedReviewAsk = (message: MailReviewMessage): Pick<MailReviewOptions, "ask"> => {
  switch (message) {
    case "draft.discard":
    case "draft.attachment.remove":
    case "conversation.comment.delete":
    case "mailbox.tag.delete":
      return { ask: "deletes" };
    case "delivery.cancel":
    case "conversation.keep.release":
    case "conversation.comment.update":
      return { ask: "cannot_undo" };
    case "draft.send":
    case "draft.send.scheduled":
    case "mailing-list.unsubscribe":
      return { ask: "sends" };
    default:
      return {};
  }
};
export const buildMailReview = (
  message: MailReviewMessage,
  locale: string | undefined,
  slots: Record<string, CapabilitySlot>,
  options: MailReviewOptions = {},
): CapabilityActionCallReview => {
  const language = mailReviewLocale(locale);
  const slotData = structuredClone(slots);
  const extra = structuredClone({ ...fixedReviewAsk(message), ...options });
  const review = { locale: language, sentence: mailReviewMessages(language)[message], slots: slotData, ...extra };
  // Budget the compact UTF-8 envelope separately from complete review content.
  // Counts make omissions in the card explicit.
  const compactBytes = () => {
    const { view: _view, ...compact } = review;
    return Buffer.byteLength(JSON.stringify(compact));
  };
  // Assignment batches can name two different audiences. Preserve their full counts
  // while reducing displayed people to fit the same public envelope budget.
  const personSlots = [...Object.values(slotData), ...(extra.consequences ?? []).flatMap((c) => Object.values(c.slots ?? {}))].filter(
    (s) => s.kind === "person",
  );
  while (compactBytes() > CAPABILITY_MAX_REVIEW_BYTES) {
    const largest = personSlots.reduce<(typeof personSlots)[number] | undefined>(
      (a, b) => (!a || b.people.length > a.people.length ? b : a),
      undefined,
    );
    if (!largest || largest.people.length <= 1) break;
    largest.total ??= largest.people.length;
    largest.people.pop();
  }
  return actionReview({ locale: language, sentence: review.sentence }, slotData, extra);
};
export const mailReceipt = (
  message: MailReviewMessage,
  locale: string | undefined,
  slots: Record<string, CapabilitySlot>,
  deletedSlot?: string,
): CapabilityActionReceipt => ({
  text: mailReviewMessages(locale)[message].done,
  slots: Object.fromEntries(
    Object.entries(slots).map(([name, slot]) => [
      name,
      name === deletedSlot && slot.kind === "object" ? { kind: "object", title: slot.title, icon: slot.icon, gone: true } : slot,
    ]),
  ),
});
export type DraftPreviewSource = {
  revision?: number;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  attachments: { filename: string; byteLength?: number }[];
};
/** Passive proposals; only draft.send exposes editable top-level input keys. */
export const draftPreview = (draft: DraftPreviewSource, locale?: string): BlockView => ({
  version: 1,
  blocks: [
    {
      kind: "Detail",
      title: mailReviewLocale(locale) === "de" ? "Entwurf" : "Draft",
      items: [
        { label: mailReviewLocale(locale) === "de" ? "Betreff" : "Subject", value: draft.subject },
        { label: mailReviewLocale(locale) === "de" ? "Text" : "Body", value: draft.body },
        {
          label: mailReviewLocale(locale) === "de" ? "An" : "To",
          value: draft.to.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(", "),
        },
        { label: "Cc", value: draft.cc.map((p) => p.address).join(", ") },
        { label: "Bcc", value: draft.bcc.map((p) => p.address).join(", ") },
        {
          label: mailReviewLocale(locale) === "de" ? "Anhänge" : "Attachments",
          value: draft.attachments.map((a) => `${a.filename}${a.byteLength === undefined ? "" : ` (${a.byteLength} B)`}`).join(", "),
        },
      ],
    },
  ],
});
export const commentPreview = (text: string, locale?: string, before?: string): BlockView => ({
  version: 1,
  blocks: [
    {
      kind: "Detail",
      title: mailReviewCopy(locale).comment,
      items: [{ label: mailReviewLocale(locale) === "de" ? "Text" : "Body", value: text, ...(before === undefined ? {} : { before }) }],
    },
  ],
});
export type SendReviewSource = {
  contentHash: string;
  renderedBody?: string;
  draft: DraftPreviewSource;
  from: CapabilityPerson;
  expectedRevision: number;
  mailboxId: string;
  draftId: string;
  href: string;
  scheduledAt?: string;
  undoSeconds?: number;
  warnings: { title: string; description: string }[];
};
export const buildSendReview = (source: SendReviewSource, locale?: string): CapabilityActionCallReview => {
  const recipients = source.draft.to.length ? source.draft.to : source.draft.cc.length ? source.draft.cc : source.draft.bcc;
  if (!recipients.length) throw new Error("At least one recipient is required before sending");
  const de = mailReviewLocale(locale) === "de";
  const people = (values: MailAddress[]) =>
    // People rows hold 200 entries with 200-character labels. Keep larger Mail
    // audiences and addresses complete as text rather than shortening them.
    values.length <= 200 && values.every((p) => p.address.length <= 200 && (!p.name || p.name.length <= 200))
      ? values.map((p) => ({ ...(p.name ? { name: p.name } : {}), address: p.address }))
      : values.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(", ");
  const context = [
    { label: de ? "An" : "To", value: people(source.draft.to) },
    ...(source.draft.cc.length ? [{ label: "Cc", value: people(source.draft.cc) }] : []),
    ...(source.draft.bcc.length ? [{ label: "Bcc", value: people(source.draft.bcc) }] : []),
    {
      label: de ? "Von" : "From",
      value: source.from.name ? `${source.from.name} <${source.from.address ?? ""}>` : (source.from.address ?? "—"),
    },
    {
      label: de ? "Anhänge" : "Attachments",
      value: source.draft.attachments.map((a) => `${a.filename}${a.byteLength === undefined ? "" : ` (${a.byteLength} B)`}`).join(", "),
    },
    ...(source.scheduledAt ? [{ label: de ? "Sendezeit" : "Send at", value: source.scheduledAt }] : []),
  ];
  return buildMailReview(
    source.scheduledAt ? "draft.send.scheduled" : "draft.send",
    locale,
    {
      subject: reviewObject(source.draft.subject || mailCapabilityMessages(locale).noSubject, { type: "mail.draft", id: source.draftId }),
      to: reviewPeople(recipients.map(reviewPerson)),
      ...(source.scheduledAt ? { at: reviewTime(source.scheduledAt) } : {}),
    },
    {
      ask: "sends",
      view: {
        version: 1,
        blocks: [
          {
            kind: "Draft",
            context,
            fields: [
              { name: "subject", label: de ? "Betreff" : "Subject", type: "text", value: source.draft.subject },
              { name: "body", label: de ? "Text" : "Body", type: "textarea", value: source.draft.body },
            ],
          },
          ...(source.renderedBody !== undefined && source.renderedBody !== source.draft.body
            ? [
                {
                  kind: "Detail" as const,
                  title: de ? "Versandtext" : "Rendered message",
                  items: [{ label: de ? "Text" : "Body", value: source.renderedBody }],
                },
              ]
            : []),
          ...source.warnings.map((w) => ({ kind: "Notice" as const, tone: "warning" as const, title: w.title, text: w.description })),
        ],
      },
      links: [
        { rel: "open", href: source.href },
        { rel: "edit", href: source.href, title: de ? "Empfänger in Mail ändern" : "Change recipients in Mail" },
      ],
      check: {
        query: "draft.send.check",
        input: { mailboxId: source.mailboxId, draftId: source.draftId, expectedRevision: source.expectedRevision },
      },
      ...(!source.scheduledAt && source.undoSeconds ? { consequences: [{ text: mailReviewCopy(locale).undo(source.undoSeconds) }] } : {}),
    },
  );
};

export const markReviewMessage = (read: boolean | undefined, flagged: boolean | undefined): MailReviewMessage => {
  if (read === undefined) return flagged ? "conversation.mark.flag" : "conversation.mark.unflag";
  if (flagged === undefined) return read ? "conversation.mark.read" : "conversation.mark.unread";
  return read
    ? flagged
      ? "conversation.mark.read.flag"
      : "conversation.mark.read.unflag"
    : flagged
      ? "conversation.mark.unread.flag"
      : "conversation.mark.unread.unflag";
};
export const sendReceipt = (
  draft: Pick<DraftPreviewSource, "subject" | "to" | "cc" | "bcc">,
  draftId: string,
  scheduledAt: string | undefined,
  locale?: string,
): CapabilityActionReceipt => {
  const to = draft.to.length ? draft.to : draft.cc.length ? draft.cc : draft.bcc;
  const slots = {
    subject: reviewObject(draft.subject || mailCapabilityMessages(locale).noSubject, { type: "mail.draft", id: draftId }),
    ...(scheduledAt ? { at: reviewTime(scheduledAt) } : {}),
  };
  return to.length
    ? mailReceipt(scheduledAt ? "draft.send.scheduled" : "draft.send", locale, { ...slots, to: reviewPeople(to.map(reviewPerson)) })
    : {
        text: scheduledAt ? mailReviewCopy(locale).scheduledWithoutRecipient : mailReviewCopy(locale).sendWithoutRecipient,
        slots,
      };
};
export const folderDisplayReceipt = (
  effectiveDisplay: "everywhere" | "folder_only" | "hidden",
  folder: CapabilitySlot,
  parent: CapabilitySlot | undefined,
  locale?: string,
): CapabilityActionReceipt =>
  parent
    ? { text: mailReviewCopy(locale).folderInherited, slots: { folder, parent } }
    : mailReceipt(`folder.display.set.${effectiveDisplay}`, locale, { folder });

export const batchReceipt = (
  message: MailReviewMessage,
  count: number,
  total: number,
  locale?: string,
  slots: Record<string, CapabilitySlot> = {},
): CapabilityActionReceipt => {
  const receipt = mailReceipt(message, locale, { ...slots, count: reviewCount(count, locale) });
  if (count !== total)
    receipt.text = mailReviewCopy(locale).partial(count, total) + receipt.text + mailReviewCopy(locale).missing(total - count);
  return receipt;
};

export const assignmentReviewMessage = (mode: "add" | "remove" | "replace", people: CapabilitySlot, batch = false): MailReviewMessage =>
  `conversation.assign.${batch ? "batch." : ""}${mode === "replace" && people.kind === "person" && (people.total ?? people.people.length) === 0 ? "clear" : mode}`;

// Each action owns a pure projection; loaders supply only loaded display data.
// Slot keys are checked here, while the catalog also checks their sentence use.
const reviewBuilder =
  <K extends string>(message: MailReviewMessage) =>
  (locale: string | undefined, slots: Record<K, CapabilitySlot>, options: MailReviewOptions = {}) =>
    buildMailReview(message, locale, slots, options);
export const mailActionReviews = {
  "draft.create": reviewBuilder<"draft">("draft.create"),
  "draft.patch": reviewBuilder<"draft">("draft.patch"),
  "draft.update": reviewBuilder<"draft">("draft.update"),
  "draft.discard": reviewBuilder<"draft">("draft.discard"),
  "draft.attachment.add": reviewBuilder<"file" | "draft">("draft.attachment.add"),
  "draft.attachment.remove": reviewBuilder<"file" | "draft">("draft.attachment.remove"),
  "delivery.cancel": reviewBuilder<"delivery">("delivery.cancel"),
  "conversation.move": reviewBuilder<"conversation" | "folder">("conversation.move"),
  "conversation.tag.update": reviewBuilder<"conversation">("conversation.tag.update"),
  "conversation.keep": reviewBuilder<"conversation">("conversation.keep"),
  "conversation.keep.release": reviewBuilder<"conversation">("conversation.keep.release"),
  "conversation.reminder.set": reviewBuilder<"conversation" | "at">("conversation.reminder.set"),
  "conversation.reminder.cancel": reviewBuilder<"conversation">("conversation.reminder.cancel"),
  "conversation.comment.create": reviewBuilder<"conversation">("conversation.comment.create"),
  "conversation.comment.update": reviewBuilder<"conversation">("conversation.comment.update"),
  "conversation.comment.delete": reviewBuilder<"conversation">("conversation.comment.delete"),
  "folder.display.set": (
    display: "everywhere" | "folder_only" | "hidden",
    locale: string | undefined,
    slots: Record<"folder", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(`folder.display.set.${display}`, locale, slots, options),
  "mailbox.tag.create": reviewBuilder<"tag">("mailbox.tag.create"),
  "mailbox.tag.update": reviewBuilder<"tag">("mailbox.tag.update"),
  "mailbox.tag.delete": reviewBuilder<"tag">("mailbox.tag.delete"),
  "mailing-list.unsubscribe": reviewBuilder<"list">("mailing-list.unsubscribe"),
  "draft.send": buildSendReview,
  "conversation.mark": (
    read: boolean | undefined,
    flagged: boolean | undefined,
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(markReviewMessage(read, flagged), locale, slots, options),
  "conversation.assign": (
    mode: "add" | "remove" | "replace",
    locale: string | undefined,
    slots: Record<"conversation" | "people", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) =>
    buildMailReview(
      assignmentReviewMessage(mode, slots.people),
      locale,
      mode === "replace" && slots.people.kind === "person" && (slots.people.total ?? slots.people.people.length) === 0
        ? { conversation: slots.conversation }
        : slots,
      options,
    ),
  "conversation.assign.batch": (
    mode: "add" | "remove" | "replace",
    locale: string | undefined,
    slots: Record<"count" | "people", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) =>
    buildMailReview(
      assignmentReviewMessage(mode, slots.people, true),
      locale,
      mode === "replace" && slots.people.kind === "person" && (slots.people.total ?? slots.people.people.length) === 0
        ? { count: slots.count }
        : slots,
      options,
    ),
  "conversation.summary.write": (
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview("conversation.summary.write", locale, slots, options),
  "conversation.reference.ensure": (
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview("conversation.reference.ensure", locale, slots, options),
  "conversation.status.update": (
    status: "done" | "open" | "waiting" | "needs_action",
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(`conversation.status.update.${status}`, locale, slots, options),
  "conversation.status.update.batch": (
    status: "done" | "open" | "waiting" | "needs_action",
    locale: string | undefined,
    slots: Record<"count", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(`conversation.status.update.batch.${status}`, locale, slots, options),
  "conversation.status.set": (
    status: "done" | "open" | "waiting" | "needs_action",
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(`conversation.status.update.${status}`, locale, slots, options),
  "conversation.status.set.batch": (
    status: "done" | "open" | "waiting" | "needs_action",
    locale: string | undefined,
    slots: Record<"count", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(`conversation.status.update.batch.${status}`, locale, slots, options),
  "conversation.snooze": (
    until: string | null | undefined,
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot> & { at?: CapabilitySlot },
    options: MailReviewOptions = {},
  ) =>
    buildMailReview(
      until ? "conversation.snooze" : "conversation.snooze.now",
      locale,
      { conversation: slots.conversation, ...(slots.at ? { at: slots.at } : {}) },
      options,
    ),
};
