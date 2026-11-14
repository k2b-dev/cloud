type TimelineMessage = { id: string; internalDate: string };
type TimelineNote = { id: string; createdAt: string };

/** One entry of the reader's timeline: a message, or an internal note at its own time. */
export type MailConversationTimelineItem<T extends TimelineMessage, N extends TimelineNote> =
  | { kind: "message"; id: string; occurredAt: string; message: T }
  | { kind: "note"; id: string; occurredAt: string; note: N };

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The conversation in reading order (Mail v5): oldest first, the newest message at the bottom, each internal note
 * between the messages at the time it was written. Equal times keep messages before notes, then a stable id order.
 */
export const buildMailConversationTimeline = <T extends TimelineMessage, N extends TimelineNote>(
  messages: readonly T[],
  notes: readonly N[],
): MailConversationTimelineItem<T, N>[] =>
  [
    ...messages.map((message) => ({ kind: "message" as const, id: `message:${message.id}`, occurredAt: message.internalDate, message })),
    ...notes.map((note) => ({ kind: "note" as const, id: `note:${note.id}`, occurredAt: note.createdAt, note })),
  ].sort(
    (left, right) =>
      timestamp(left.occurredAt) - timestamp(right.occurredAt) ||
      (left.kind === right.kind ? 0 : left.kind === "message" ? -1 : 1) ||
      left.id.localeCompare(right.id),
  );
