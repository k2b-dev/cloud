import { actionReview } from "@k2b/cloud/capabilities";
import type {
  CapabilityActionCallReview,
  CapabilityActionReceipt,
  CapabilityPerson,
  CapabilityPreview,
  CapabilityReviewContent,
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
const block = (value: string) =>
  value.replace(/[^\S\n\t]/gu, " ").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
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
    const { content: _content, ...compact } = review;
    return Buffer.byteLength(JSON.stringify(compact));
  };
  const p = review.preview;
  if (p?.kind === "message") {
    while (compactBytes() > CAPABILITY_MAX_REVIEW_BYTES) {
      const lists = ["to", "cc", "bcc"] as const;
      const longest = lists.reduce((a, b) => ((p[a]?.length ?? 0) >= (p[b]?.length ?? 0) ? a : b));
      if ((p[longest]?.length ?? 0) > 1) {
        p[longest]!.pop();
        p.more = { ...p.more, [longest]: (p.more?.[longest] ?? 0) + 1 };
      } else if ((p.attachments?.length ?? 0) > 0) {
        p.attachments!.pop();
        p.moreAttachments = (p.moreAttachments ?? 0) + 1;
      } else if (p.body.length > 0) {
        p.body = reviewSlice(p.body, Math.floor(p.body.length / 2));
        p.truncated = true;
      } else {
        // The person slot is a summary, the preview retains each address or its explicit count.
        const people = Object.values(slotData).find((s) => s.kind === "person" && s.people.length > 1);
        if (!people || people.kind !== "person") break;
        people.people.pop();
      }
    }
  }
  if (p?.kind === "message" && p.attachments?.length === 0) delete p.attachments;
  if (p?.kind === "page")
    while (compactBytes() > CAPABILITY_MAX_REVIEW_BYTES && p.body.length) {
      p.body = reviewSlice(p.body, Math.floor(p.body.length / 2));
      p.truncated = true;
    }
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
export const draftPreview = (draft: DraftPreviewSource, locale?: string): CapabilityPreview => {
  const body = reviewSlice(block(draft.body), 10_000);
  const truncated = body.length < block(draft.body).length;
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0)
    return {
      kind: "page",
      title: reviewLine(draft.subject || mailCapabilityMessages(locale).noSubject),
      body,
      format: draft.format,
      truncated,
    };
  return {
    kind: "message",
    subject: reviewLine(draft.subject, 998),
    body,
    format: draft.format,
    truncated,
    to: draft.to.slice(0, 50).map(reviewPerson),
    ...(draft.cc.length ? { cc: draft.cc.slice(0, 50).map(reviewPerson) } : {}),
    ...(draft.bcc.length ? { bcc: draft.bcc.slice(0, 50).map(reviewPerson) } : {}),
    ...(draft.to.length > 50 || draft.cc.length > 50 || draft.bcc.length > 50
      ? {
          more: {
            ...(draft.to.length > 50 ? { to: draft.to.length - 50 } : {}),
            ...(draft.cc.length > 50 ? { cc: draft.cc.length - 50 } : {}),
            ...(draft.bcc.length > 50 ? { bcc: draft.bcc.length - 50 } : {}),
          },
        }
      : {}),
    ...(draft.attachments.length
      ? {
          attachments: draft.attachments
            .slice(0, 50)
            .map((a) => ({ name: reviewLine(a.filename, 255), ...(a.byteLength === undefined ? {} : { size: a.byteLength }) })),
        }
      : {}),
    ...(draft.attachments.length > 50 ? { moreAttachments: draft.attachments.length - 50 } : {}),
  };
};
/** Exact proposed source; controls are made visible by Cloud's reader, never removed here. */
export const draftReviewContent = (draft: DraftPreviewSource): Extract<CapabilityReviewContent, { kind: "message" }> => ({
  kind: "message",
  ...(draft.revision === undefined ? {} : { baseRevision: draft.revision }),
  subject: draft.subject,
  body: draft.body,
  format: "plain",
  to: draft.to.map((p) => ({ address: p.address, ...(p.name == null ? {} : { name: p.name }) })),
  cc: draft.cc.map((p) => ({ address: p.address, ...(p.name == null ? {} : { name: p.name }) })),
  bcc: draft.bcc.map((p) => ({ address: p.address, ...(p.name == null ? {} : { name: p.name }) })),
  attachments: draft.attachments.map((a) => ({ name: a.filename, ...(a.byteLength === undefined ? {} : { size: a.byteLength }) })),
});
export const commentPreview = (text: string, locale?: string, before?: string): CapabilityPreview => ({
  kind: "page",
  title: mailReviewCopy(locale).comment,
  body: reviewSlice(block(text), 10_000),
  format: "plain",
  truncated: block(text).length > 10_000,
  ...(before !== undefined && block(before).length <= 2_000 ? { changes: [{ change: "removed", text: block(before) }] } : {}),
});
export type SendReviewSource = {
  contentHash: string;
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
  const p = draftPreview(source.draft, locale);
  if (p.kind !== "message") throw new Error("A send preview must be a message");
  p.from = {
    ...source.from,
    ...(source.from.name === undefined ? {} : { name: reviewLine(source.from.name) }),
    ...(source.from.address === undefined ? {} : { address: reviewLine(source.from.address, 320) }),
  };
  if (source.scheduledAt) p.sendAt = source.scheduledAt;
  const warningLead = (title: string) => (/\p{P}$/u.test(title) ? title : title + ".");
  const warnings = source.warnings.map((w) => warningLead(w.title) + " " + w.description);
  const compactWarnings = warnings.map((warning) => reviewLine(warning, 300));
  // Six kinds currently exist. Keep complete first four, then every remaining lead.
  p.warnings =
    compactWarnings.length <= 5
      ? compactWarnings
      : [
          ...compactWarnings.slice(0, 4),
          source.warnings
            .slice(4)
            .map((w) => warningLead(reviewLine(w.title, 140)))
            .join(" "),
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
      preview: p,
      content: {
        ...draftReviewContent(source.draft),
        from: source.from,
        ...(source.scheduledAt ? { sendAt: source.scheduledAt } : {}),
        warnings,
      },
      links: [{ rel: "open", href: source.href }],
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
  "conversation.status.update": (
    status: "done" | "open",
    locale: string | undefined,
    slots: Record<"conversation", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) => buildMailReview(status === "done" ? "conversation.status.update.done" : "conversation.status.update.open", locale, slots, options),
  "conversation.status.update.batch": (
    status: "done" | "open",
    locale: string | undefined,
    slots: Record<"count", CapabilitySlot>,
    options: MailReviewOptions = {},
  ) =>
    buildMailReview(
      status === "done" ? "conversation.status.update.batch.done" : "conversation.status.update.batch.open",
      locale,
      slots,
      options,
    ),
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
