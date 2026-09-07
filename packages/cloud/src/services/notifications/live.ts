import { lazySync } from "../../_internal/process-sync";
import type { NotificationLiveEvent } from "../../contracts/notification-live";
import type { NotificationPresentation } from "../../contracts/notification-types";
import { logger } from "../logging";
import { latestTopicCursor } from "../topic-cursor";

const LIVE_TOPIC_ID = "cloud:notifications:live";
const LIVE_RETENTION_MS = 60 * 60 * 1_000;

const log = logger("notifications:live");

const liveTopic = lazySync((sync) =>
  sync.topic<NotificationLiveEvent>({
    id: LIVE_TOPIC_ID,
    owner: "core",
    // One hour of foreground alerts fits the shared event-log storage budget.
    retention: { maxAgeMs: LIVE_RETENTION_MS, maxBytes: 64 * 1024 * 1024 },
    maxPayloadBytes: 9_000,
  }),
);

const publish = async (input: { userId: string; eventId: string; presentation: NotificationPresentation }): Promise<void> => {
  const event: NotificationLiveEvent = {
    type: "cloud-notification",
    eventId: input.eventId,
    title: input.presentation.title,
    ...(input.presentation.targetHref ? { targetHref: input.presentation.targetHref } : {}),
  };
  try {
    await liveTopic().publish({
      tenantId: input.userId,
      orderingKey: input.userId,
      idempotencyKey: `event:${input.eventId}`,
      data: event,
    });
  } catch (error) {
    log.warn("Failed to publish foreground notification", {
      eventId: input.eventId,
      error: error instanceof Error ? error.message : "Foreground notification publish failed",
    });
  }
};

export const notificationLive = {
  publish,
  latestCursor: (userId: string): Promise<string> => latestTopicCursor({ topic: liveTopic(), resourceId: LIVE_TOPIC_ID, tenantId: userId }),
  emptyCursor: (): string => liveTopic().cursorAt(0),
  events: (input: { userId: string; after?: string; signal?: AbortSignal }) =>
    liveTopic().hub({ tenantId: input.userId }).subscribe({ after: input.after, signal: input.signal }),
} as const;
