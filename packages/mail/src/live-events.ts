import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

/**
 * One change that open pages of a mailbox apply: the public ID of the
 * conversation it touched, or `null` when it concerns the mailbox as a whole.
 * It travels on the live channel `mailbox`, keyed by the mailbox, and is
 * written by `mail.enqueue_live_invalidation()` in the transaction that makes
 * the change.
 */
export const MailLiveEventSchema = z.object({ conversationId: ResourceShortIdSchema.nullable() }).strict();

export type MailLiveEvent = z.infer<typeof MailLiveEventSchema>;
