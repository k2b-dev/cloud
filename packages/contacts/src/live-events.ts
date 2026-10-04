import { z } from "zod";
import { ResourceShortIdSchema } from "./capability-contracts";

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
