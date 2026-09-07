import { z } from "zod";
import { ResourceShortIdSchema } from "./capability-contracts";

export const CONTACTS_LIVE_WS_TYPE = {
  subscribe: "contacts.live.subscribe",
  ready: "contacts.live.ready",
  event: "contacts.live.event",
  scopeChanged: "contacts.live.scope_changed",
  revoked: "contacts.live.revoked",
  error: "contacts.live.error",
} as const;

const InternalIdSchema = z.uuid();
const StreamCursorSchema = z
  .string()
  .max(256)
  .regex(/^s6t\.[A-Za-z0-9_-]+\.\d+$/);

const contactEventSchema = (bookId: z.ZodType<string>, contactId: z.ZodType<string>) =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.enum(["book.created", "book.updated", "book.deleted", "access.changed", "tags.changed"]),
      bookId,
      at: z.string().datetime(),
    }),
    z.object({
      type: z.enum(["contact.created", "contact.updated", "contact.deleted"]),
      bookId,
      contactId,
      at: z.string().datetime(),
    }),
    z.object({
      type: z.enum(["contacts.imported", "contacts.changed"]),
      bookId,
      at: z.string().datetime(),
    }),
    z.object({
      type: z.literal("contact.moved"),
      sourceBookId: bookId,
      targetBookId: bookId,
      contactId,
      at: z.string().datetime(),
    }),
    z.object({
      type: z.literal("notes.changed"),
      bookId,
      contactId,
      at: z.string().datetime(),
    }),
  ]);

export const ContactServiceEventSchema = contactEventSchema(InternalIdSchema, InternalIdSchema);
export const ContactLiveEventSchema = contactEventSchema(ResourceShortIdSchema, ResourceShortIdSchema);

export type ContactServiceEvent = z.infer<typeof ContactServiceEventSchema>;
export type ContactLiveEvent = z.infer<typeof ContactLiveEventSchema>;
export type ContactServiceEventData = ContactServiceEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, "at">
    : never
  : never;

const ContactLiveScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("book"), bookId: ResourceShortIdSchema }),
]);

export type ContactLiveScope = z.infer<typeof ContactLiveScopeSchema>;

export const ContactLiveClientMessageSchema = z.object({
  type: z.literal(CONTACTS_LIVE_WS_TYPE.subscribe),
  payload: z.object({
    scope: ContactLiveScopeSchema,
    // Legacy cursors are accepted only so the server can request a fresh snapshot.
    fromCursor: z
      .string()
      .max(256)
      .regex(/^(?:s6t\.[A-Za-z0-9_-]+\.\d+|\d+-\d+)$/)
      .nullable(),
  }),
});

export type ContactLiveClientMessage = z.infer<typeof ContactLiveClientMessageSchema>;

const ContactLiveServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(CONTACTS_LIVE_WS_TYPE.ready),
    payload: z.object({ cursor: StreamCursorSchema }),
  }),
  z.object({
    type: z.literal(CONTACTS_LIVE_WS_TYPE.event),
    payload: z.object({ cursor: StreamCursorSchema, event: ContactLiveEventSchema }),
  }),
  z.object({
    type: z.literal(CONTACTS_LIVE_WS_TYPE.scopeChanged),
    payload: z.object({ change: z.enum(["gained", "lost", "mixed"]) }),
  }),
  z.object({
    type: z.literal(CONTACTS_LIVE_WS_TYPE.revoked),
    payload: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
  z.object({
    type: z.literal(CONTACTS_LIVE_WS_TYPE.error),
    payload: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
]);

export type ContactLiveServerMessage = z.infer<typeof ContactLiveServerMessageSchema>;

export const parseContactLiveServerMessage = (raw: string): ContactLiveServerMessage | null => {
  try {
    const parsed = ContactLiveServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Returns every manual book whose visibility may be affected by an event. */
export const contactEventBookIds = (event: ContactServiceEvent): string[] =>
  event.type === "contact.moved" ? [event.sourceBookId, event.targetBookId] : [event.bookId];

export const classifyContactScopeChange = (before: ReadonlySet<string>, after: ReadonlySet<string>): "gained" | "lost" | "mixed" => {
  const gained = [...after].some((id) => !before.has(id));
  const lost = [...before].some((id) => !after.has(id));
  return gained && lost ? "mixed" : lost ? "lost" : "gained";
};

/** Removes book identifiers the subscriber cannot read from move events. */
export const projectContactEvent = (event: ContactServiceEvent, readableBookIds: ReadonlySet<string>): ContactServiceEvent | null => {
  if (event.type !== "contact.moved") return readableBookIds.has(event.bookId) ? event : null;

  const canReadSource = readableBookIds.has(event.sourceBookId);
  const canReadTarget = readableBookIds.has(event.targetBookId);
  if (canReadSource && canReadTarget) return event;
  if (canReadSource) {
    return { type: "contact.deleted", bookId: event.sourceBookId, contactId: event.contactId, at: event.at };
  }
  if (canReadTarget) {
    return { type: "contact.created", bookId: event.targetBookId, contactId: event.contactId, at: event.at };
  }
  return null;
};
