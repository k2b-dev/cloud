import { lazySync } from "@valentinkolb/cloud";
import { latestTopicCursor, logger } from "@valentinkolb/cloud/services";
import type { ContactLiveEvent, ContactServiceEvent, ContactServiceEventData } from "../live-events";
import { projectContactEventIds } from "./public-resources";

const log = logger("contacts:events");
const CONTACTS_EVENT_TENANT = "contacts";
const TOPIC_OPERATION_TIMEOUT_MS = 1_500;

export type ContactEventEnvelope = { internal: ContactServiceEvent; public: ContactLiveEvent };

const contactsTopic = lazySync((sync) =>
  sync.topic<ContactEventEnvelope>({
    id: "cloud:contacts:events:changes",
    retention: { maxAgeMs: 24 * 60 * 60 * 1_000, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: 8_000,
  }),
);

const eventResourceId = (event: ContactServiceEventData): string => {
  if (event.type === "contact.moved") return event.contactId;
  if ("contactId" in event) return event.contactId;
  return event.bookId;
};

const withTopicTimeout = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Contacts live topic timed out")), TOPIC_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const publishContactEvent = async (event: ContactServiceEventData, knownPublicEvent?: ContactLiveEvent): Promise<void> => {
  const payload: ContactServiceEvent = { ...event, at: new Date().toISOString() };
  const resourceId = eventResourceId(event);
  try {
    await withTopicTimeout(
      contactsTopic().publish({
        tenantId: CONTACTS_EVENT_TENANT,
        orderingKey: resourceId,
        data: {
          internal: payload,
          public: knownPublicEvent ? { ...knownPublicEvent, at: payload.at } : await projectContactEventIds(payload),
        },
      }),
    );
  } catch (error) {
    log.warn("Failed to publish Contacts event", {
      type: payload.type,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const liveContactEvents = (config: { after?: string | null; signal?: AbortSignal }) =>
  contactsTopic()
    .hub({ tenantId: CONTACTS_EVENT_TENANT })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });

export const latestContactEventCursor = (): Promise<string | null> =>
  withTopicTimeout(
    latestTopicCursor({ topic: contactsTopic(), resourceId: "cloud:contacts:events:changes", tenantId: CONTACTS_EVENT_TENANT }),
  );

/** SSR remains available when the best-effort live transport is unavailable. */
export const captureContactEventCursor = async (): Promise<string> => {
  try {
    return (await latestContactEventCursor()) ?? contactsTopic().cursorAt(0);
  } catch (error) {
    log.warn("Failed to capture Contacts event cursor", {
      error: error instanceof Error ? error.message : String(error),
    });
    return contactsTopic().cursorAt(0);
  }
};
