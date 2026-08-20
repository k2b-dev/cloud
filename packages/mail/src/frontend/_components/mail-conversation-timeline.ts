import type { MailActivityEvent } from "../../service/collaboration";
import { type PresentedMailActivity, presentMailActivity, showMailActivityInline } from "./mail-activity-presentation";

type TimelineMessage = { id: string; internalDate: string };

export type MailConversationTimelineItem<T extends TimelineMessage> =
  | { kind: "message"; id: string; occurredAt: string; message: T }
  | { kind: "activity"; id: string; occurredAt: string; activity: PresentedMailActivity };

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const buildMailConversationTimeline = <T extends TimelineMessage>(
  messages: readonly T[],
  activity: readonly MailActivityEvent[],
): MailConversationTimelineItem<T>[] => {
  const items: MailConversationTimelineItem<T>[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      occurredAt: message.internalDate,
      message,
    })),
    ...activity.filter(showMailActivityInline).map((event) => ({
      kind: "activity" as const,
      id: `activity:${event.id}`,
      occurredAt: event.createdAt,
      activity: presentMailActivity([event])[0]!,
    })),
  ].sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt) || right.id.localeCompare(left.id));

  const timeline: MailConversationTimelineItem<T>[] = [];
  for (const item of items) {
    const previous = timeline.at(-1);
    if (
      item.kind === "activity" &&
      previous?.kind === "activity" &&
      previous.activity.actor.kind === item.activity.actor.kind &&
      previous.activity.actor.id === item.activity.actor.id &&
      previous.activity.label === item.activity.label
    ) {
      previous.activity.count += item.activity.count;
      continue;
    }
    timeline.push(item);
  }
  return timeline;
};
