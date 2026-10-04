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

const StreamCursorSchema = z
  .string()
  .max(256)
  .regex(/^s6t\.[A-Za-z0-9_-]+\.\d+$/);

/**
 * One change in one book, with public IDs. A move is a deletion in the source
 * book and a creation in the target book, so a reader of one book never learns
 * the other.
 */
export const ContactLiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["book.updated", "book.deleted", "access.changed", "tags.changed", "contacts.imported", "contacts.changed"]),
    bookId: ResourceShortIdSchema,
    at: z.string().datetime(),
  }),
  z.object({
    type: z.enum(["contact.created", "contact.updated", "contact.deleted", "notes.changed"]),
    bookId: ResourceShortIdSchema,
    contactId: ResourceShortIdSchema,
    at: z.string().datetime(),
  }),
]);

export type ContactLiveEvent = z.infer<typeof ContactLiveEventSchema>;

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

export const classifyContactScopeChange = (before: ReadonlySet<string>, after: ReadonlySet<string>): "gained" | "lost" | "mixed" => {
  const gained = [...after].some((id) => !before.has(id));
  const lost = [...before].some((id) => !after.has(id));
  return gained && lost ? "mixed" : lost ? "lost" : "gained";
};
