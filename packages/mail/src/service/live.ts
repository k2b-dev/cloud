import { defineLive } from "@k2b/cloud/events";
import type { sql } from "bun";
import { MAIL_APP_ID } from "../app-identity";
import { MailLiveEventSchema } from "../live-events";

/**
 * Live updates keyed by the internal mailbox ID: every reader of a mailbox may
 * see its updates. Mail writes them in SQL, through `mail.enqueue_live_invalidation()`,
 * which the trigger on `mail.activity_events` also calls, so every activity
 * row reaches open pages. Updates of one conversation, or of the mailbox as a
 * whole, in one transaction are written once.
 */
export const mailLive = defineLive({ appId: MAIL_APP_ID, event: MailLiveEventSchema });

/** Writes a live update in `tx` for a change that records no activity row. Call `mailLive.wake()` after the commit. */
export const enqueueMailInvalidation = async (
  tx: typeof sql,
  params: { mailboxId: string; conversationId?: string | null },
): Promise<void> => {
  await tx`SELECT mail.enqueue_live_invalidation(${params.mailboxId}::uuid, ${params.conversationId ?? null}::uuid)`;
};

/**
 * A committed change as domain functions report it. Its activity row already
 * wrote the live update; `mailLive.wake()` publishes it right away.
 */
export type MailActivityChange = {
  mailboxId: string;
  conversationId: string | null;
  reason: string;
  targetId: string | null;
  activityId: string;
};
