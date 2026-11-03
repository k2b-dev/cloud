import { type DateContext, dates } from "@k2b/stdlib";
import type { MailActivityEvent, MailActivityPerson } from "../../service/collaboration";
import { mailEventsMessages } from "./mail-events-messages";

/** The colour family of an event's icon; errors and warnings also colour the detail line. */
export type MailEventTone = "assign" | "sent" | "draft" | "done" | "comment" | "automation" | "error" | "warning";

export type PresentedMailEvent = {
  /** The newest event of a group, which also keys the row. */
  event: MailActivityEvent;
  actorLabel: string;
  automated: boolean;
  icon: string;
  tone: MailEventTone;
  before: string;
  /** The conversation's subject between the two sentence parts; null when the event has no conversation. */
  subject: string | null;
  after: string;
  detail: string | null;
  /** Consecutive equal events of one person in one conversation show once, with their count. */
  count: number;
  day: string;
  time: string;
};

type Snapshot = { assigneeUserIds?: unknown; assigneeUserId?: unknown; workStatus?: unknown; tagIds?: unknown };

const snapshot = (value: unknown): Snapshot => (value && typeof value === "object" ? (value as Snapshot) : {});
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
const assigneeIds = (value: Snapshot): string[] =>
  Array.isArray(value.assigneeUserIds)
    ? ids(value.assigneeUserIds)
    : typeof value.assigneeUserId === "string"
      ? [value.assigneeUserId]
      : [];

export type MailEventContext = {
  locale: string;
  currentUserId: string;
  dateConfig: DateContext;
  now: Date;
  /** The mailbox's tag names by public ID, for what an automation tagged. */
  tagName: (id: string) => string | undefined;
};

type Sentence = Pick<PresentedMailEvent, "icon" | "tone" | "before" | "after" | "detail"> & { subject?: string | null };

const describe = (event: MailActivityEvent, context: MailEventContext): Sentence => {
  const t = mailEventsMessages.resolve([context.locale]).t;
  const metadata = event.metadata;
  const before = snapshot(metadata.before);
  const after = snapshot(metadata.after);
  // Sentences name people; only the list of assignees below says "You", which reads the same in every grammatical case.
  const names = (people: readonly MailActivityPerson[], you = false) =>
    new Intl.ListFormat(context.locale, { type: "conjunction" }).format(
      people.map((person) => (you && person.id === context.currentUserId ? t.you : person.displayName)),
    );
  const detailFor = (people: readonly MailActivityPerson[]) => (people.length ? t.assignees({ names: names(people, true) }) : null);

  if (event.action === "conversation.collaboration_updated" && event.assignees) {
    const { before: was, after: now } = event.assignees;
    const beforeIds = assigneeIds(before);
    const afterIds = assigneeIds(after);
    const added = now.filter((person) => !beforeIds.includes(person.id));
    const removed = was.filter((person) => !afterIds.includes(person.id));
    const detail = detailFor(now);
    if (afterIds.length === 0)
      return { icon: "ti ti-user-off", tone: "assign", before: t.unassignedBefore, after: t.unassignedAfter, detail };
    if (added.length === 0)
      return {
        icon: "ti ti-user-minus",
        tone: "assign",
        before: t.assigneeRemovedBefore({ names: names(removed) }),
        after: t.assigneeRemovedAfter,
        detail,
      };
    if (added.length === 1 && added[0]!.id === event.actor.id && event.actor.kind === "user")
      return { icon: "ti ti-user-check", tone: "assign", before: t.assignedSelfBefore, after: t.assignedSelfAfter, detail };
    if (added.some((person) => person.id === context.currentUserId))
      return { icon: "ti ti-user-share", tone: "assign", before: t.assignedYouBefore, after: t.assignedYouAfter, detail };
    return {
      icon: "ti ti-user-share",
      tone: "assign",
      before: t.assignedToBefore,
      after: t.assignedToAfter({ names: names(added) }),
      detail,
    };
  }
  if (
    (event.action === "conversation.collaboration_updated" || event.action === "conversation.work_state_changed") &&
    before.workStatus !== after.workStatus &&
    (before.workStatus === "done" || after.workStatus === "done")
  ) {
    if (after.workStatus === "done")
      return { icon: "ti ti-check", tone: "done", before: t.markedDoneBefore, after: t.markedDoneAfter, detail: null };
    return {
      icon: "ti ti-arrow-back-up",
      tone: "done",
      before: t.reopenedBefore,
      after: t.reopenedAfter,
      detail: event.actor.kind === "system" && typeof metadata.messageId === "string" ? t.reopenedByMessage : null,
    };
  }
  if (event.action === "draft.created" || event.action === "draft.derived")
    return event.conversationId
      ? { icon: "ti ti-pencil", tone: "draft", before: t.draftStartedBefore, after: t.draftStartedAfter, detail: null }
      : { icon: "ti ti-pencil", tone: "draft", before: t.draftStartedNew, after: "", detail: null, subject: null };
  if (event.action === "draft.discarded")
    return event.conversationId
      ? { icon: "ti ti-pencil-off", tone: "draft", before: t.draftDiscardedBefore, after: t.draftDiscardedAfter, detail: null }
      : { icon: "ti ti-pencil-off", tone: "draft", before: t.draftDiscardedNew, after: "", detail: null, subject: null };
  if (event.action === "conversation.comment_created")
    return { icon: "ti ti-message-circle", tone: "comment", before: t.commentedBefore, after: t.commentedAfter, detail: null };
  if (event.action === "message.sent") {
    const result = metadata.result;
    // No call to send again here: the conversation shows the delivery and its recovery.
    if (result === "failed")
      return { icon: "ti ti-alert-triangle", tone: "error", before: t.sendFailedBefore, after: t.sendFailedAfter, detail: t.sendDetails };
    if (result === "unknown")
      return {
        icon: "ti ti-alert-triangle",
        tone: "warning",
        before: t.sendUnclearBefore,
        after: t.sendUnclearAfter,
        detail: t.sendDetails,
      };
    if (result === "partial")
      return {
        icon: "ti ti-alert-triangle",
        tone: "warning",
        before: t.sendPartialBefore,
        after: t.sendPartialAfter,
        detail: t.sendDetails,
      };
    const sent =
      metadata.intent === "forward"
        ? { before: t.sentForwardBefore, after: t.sentForwardAfter }
        : metadata.intent === "new"
          ? { before: t.sentNewBefore, after: t.sentNewAfter }
          : { before: t.sentReplyBefore, after: t.sentReplyAfter };
    return result === "sent_copy_missing"
      ? { icon: "ti ti-send", tone: "warning", ...sent, detail: t.sentCopyMissing }
      : { icon: "ti ti-send", tone: "sent", ...sent, detail: null };
  }
  if (event.action.includes("local_tag")) {
    const added = ids(metadata.addedTagIds).length
      ? ids(metadata.addedTagIds)
      : ids(after.tagIds).filter((id) => !ids(before.tagIds).includes(id));
    const tags = added.flatMap((id) => context.tagName(id) ?? []);
    return tags.length
      ? {
          icon: "ti ti-tag",
          tone: "automation",
          before: t.taggedBefore,
          after: t.taggedAfter({ tags: new Intl.ListFormat(context.locale, { type: "conjunction" }).format(tags) }),
          detail: null,
        }
      : { icon: "ti ti-tag", tone: "automation", before: t.tagsChangedBefore, after: t.tagsChangedAfter, detail: null };
  }
  return { icon: "ti ti-history", tone: "automation", before: t.changedBefore, after: t.changedAfter, detail: null };
};

const actorLabel = (event: MailActivityEvent, context: MailEventContext): string => {
  const t = mailEventsMessages.resolve([context.locale]).t;
  if (event.actor.kind === "system") return t.system;
  if (event.actor.kind === "workflow")
    return event.actor.displayName === "Workflow" ? event.actor.displayName : t.workflow({ name: event.actor.displayName });
  return event.actor.displayName;
};

const dayLabel = (iso: string, context: MailEventContext): string => {
  const t = mailEventsMessages.resolve([context.locale]).t;
  const day = dates.formatDateKey(iso, context.dateConfig);
  const today = dates.formatDateKey(context.now, context.dateConfig);
  const yesterday = dates.formatDateKey(new Date(context.now.getTime() - 86_400_000), context.dateConfig);
  if (day === today) return t.today;
  if (day === yesterday) return t.yesterday;
  const date = new Date(iso);
  return `${dates.formatWeekdayLong(date, context.dateConfig)}, ${dates.formatFullDate(date, context.dateConfig)}`;
};

/**
 * Feed rows, newest first. Equal consecutive events of one person in one conversation merge into one row with a
 * count; events in different conversations never merge, so every row still names exactly one conversation.
 */
export const presentMailEvents = (events: readonly MailActivityEvent[], context: MailEventContext): PresentedMailEvent[] => {
  const t = mailEventsMessages.resolve([context.locale]).t;
  const rows: PresentedMailEvent[] = [];
  for (const event of events) {
    const sentence = describe(event, context);
    const subject = sentence.subject === null || !event.conversationId ? null : event.conversationSubject?.trim() || t.untitled;
    const row: PresentedMailEvent = {
      event,
      actorLabel: actorLabel(event, context),
      automated: event.actor.kind === "workflow",
      icon: sentence.icon,
      tone: sentence.tone,
      before: sentence.before,
      subject,
      after: sentence.after,
      detail: sentence.detail,
      count: 1,
      day: dayLabel(event.createdAt, context),
      time: dates.formatTime(event.createdAt, context.dateConfig),
    };
    const previous = rows.at(-1);
    if (
      previous &&
      event.conversationId !== null &&
      previous.event.conversationId === event.conversationId &&
      previous.event.actor.kind === event.actor.kind &&
      previous.event.actor.id === event.actor.id &&
      previous.day === row.day &&
      previous.before === row.before &&
      previous.after === row.after &&
      previous.detail === row.detail
    ) {
      previous.count += 1;
      continue;
    }
    rows.push(row);
  }
  return rows;
};

export type MailEventPages = { items: MailActivityEvent[]; nextCursor: string | null };

/**
 * The feed after the server sent its first page again, such as after a live update. Pages loaded below stay when the
 * new first page reaches into what is shown, so no event goes missing between them; otherwise the first page starts over.
 */
export const mergeMailEventPages = (shown: MailEventPages | null, first: MailEventPages): MailEventPages => {
  if (!shown || shown.items.length === 0 || first.items.length === 0) return first;
  const newestShown = BigInt(shown.items[0]!.id);
  const oldestFirst = BigInt(first.items.at(-1)!.id);
  if (first.nextCursor !== null && oldestFirst > newestShown) return first;
  const oldestShown = BigInt(shown.items.at(-1)!.id);
  // The longer reach keeps its cursor: the first page alone may end above what was loaded below.
  if (first.nextCursor === null || oldestFirst <= oldestShown) return first;
  const fresh = new Set(first.items.map((item) => item.id));
  return {
    items: [...first.items, ...shown.items.filter((item) => !fresh.has(item.id) && BigInt(item.id) < oldestFirst)],
    nextCursor: shown.nextCursor,
  };
};
