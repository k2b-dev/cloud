import { coreSettings } from "@k2b/cloud/services";
import { ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { MailDoneTodayCounts } from "../mail-view-preference";
import { conversationVisibleTo, requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";

/** One mailbox and one local calendar day, using activity_events_mailbox_idx for the time range.
 * Count each conversation once; its latest transition to done today determines the actor.
 * Reopening it later does not undo the work completed today.
 */
export const getMailboxDoneTodayCounts = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailDoneTodayCounts>> => {
  const allowed = await requireMailboxAccess(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const timezone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "Europe/Berlin";
  const now = new Date();
  const [counts] = await sql<MailDoneTodayCounts[]>`
    WITH day AS (
      SELECT (${now}::timestamptz AT TIME ZONE ${timezone})::date AS date
    ), completed AS (
      SELECT DISTINCT ON (activity.conversation_id) activity.conversation_id, activity.actor_kind
      FROM mail.activity_events activity
      CROSS JOIN day
      WHERE activity.mailbox_id = ${mailboxId}::uuid
        AND activity.created_at >= (day.date::timestamp AT TIME ZONE ${timezone})
        AND activity.created_at < ((day.date + 1)::timestamp AT TIME ZONE ${timezone})
        AND activity.action = 'conversation.collaboration_updated'
        AND activity.outcome = 'confirmed'
        AND activity.metadata #>> '{after,workStatus}' = 'done'
        AND activity.metadata #>> '{before,workStatus}' IS DISTINCT FROM 'done'
        AND activity.conversation_id IS NOT NULL
        AND ${conversationVisibleTo(allowed.data, sql`activity.conversation_id`)}
      ORDER BY activity.conversation_id, activity.created_at DESC, activity.id DESC
    )
    SELECT count(*)::int AS "doneToday",
      count(*) FILTER (WHERE actor_kind IN ('workflow', 'system'))::int AS "doneByAutomation"
    FROM completed`;
  return ok(counts ?? { doneToday: 0, doneByAutomation: 0 });
};
