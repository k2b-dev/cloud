import { sql } from "@k2b/cloud";
import type { MailActivityKind } from "../mail-activity-kinds";

/** A send settled: sent, partly sent, unclear, failed, or sent without its Sent copy. It names its conversation. */
export const MAIL_SENT_ACTIVITY_ACTION = "message.sent";

export type MailSentActivityResult = "sent" | "sent_copy_missing" | "partial" | "unknown" | "failed";

/** The outcome a settled send records, from the outbox state it settles in. */
export const mailSentActivityResult = (outboxState: string, delivered: boolean): MailSentActivityResult => {
  if (outboxState === "sent" || outboxState === "reconciled_accepted") return "sent";
  if (outboxState === "sent_sync_pending") return "sent_copy_missing";
  if (outboxState === "failed" || outboxState === "reconciled_unsent") return "failed";
  if (outboxState === "needs_attention" && delivered) return "partial";
  return "unknown";
};

const TAG_ACTIONS = [
  "conversation.local_tag_added",
  "conversation.local_tag_removed",
  "conversation.local_tags_added",
  "conversation.local_tags_updated",
] as const;

/**
 * Every action the feed can show. The partial index `activity_events_mailbox_feed_idx` uses the same list, so a feed
 * page reads only these rows in order; keep both in step (`migrate.ts`, `schema.sql`).
 */
export const MAIL_ACTIVITY_FEED_ACTIONS = [
  "conversation.collaboration_updated",
  "conversation.work_state_changed",
  "conversation.comment_created",
  "draft.created",
  "draft.discarded",
  "draft.derived",
  MAIL_SENT_ACTIVITY_ACTION,
  ...TAG_ACTIONS,
] as const;

/** Constant action names only, never request input: the planner matches the partial index on these literals. */
const actionList = (actions: readonly string[]) => sql.unsafe(actions.map((action) => `'${action}'`).join(", "));

const assigneesAt = (side: "before" | "after") =>
  sql.unsafe(
    `COALESCE(activity.metadata #> '{${side},assigneeUserIds}', jsonb_build_array(activity.metadata #> '{${side},assigneeUserId}'))`,
  );

const doneAt = (side: "before" | "after") => sql.unsafe(`(activity.metadata #>> '{${side},workStatus}' = 'done')`);

const kindCondition = (kind: MailActivityKind) => {
  switch (kind) {
    case "assignment":
      return sql`(activity.action = 'conversation.collaboration_updated' AND ${assigneesAt("before")} IS DISTINCT FROM ${assigneesAt("after")})`;
    case "status":
      return sql`(activity.action IN ('conversation.collaboration_updated', 'conversation.work_state_changed')
        AND ${doneAt("before")} IS DISTINCT FROM ${doneAt("after")})`;
    case "draft":
      return sql`activity.action IN ('draft.created', 'draft.discarded')`;
    case "comment":
      return sql`activity.action = 'conversation.comment_created'`;
    case "sent":
      return sql`activity.action = ${MAIL_SENT_ACTIVITY_ACTION}`;
    case "automation":
      return sql`activity.actor_kind = 'workflow'`;
  }
};

export type MailActivityFeedFilter = {
  /** Only events of these kinds; empty or missing keeps every recorded action, as the activity list always did. */
  kinds?: readonly MailActivityKind[];
  /** Only events this principal caused. */
  actorId?: string | null;
  /** Only events that concern this principal: theirs, ones that assign or unassign them, and ones on conversations assigned to them. */
  concernsPrincipalId?: string | null;
};

/** The feed filter as one condition on `activity`, applied before the page limit. */
export const activityFeedCondition = (filter: MailActivityFeedFilter) => {
  const kinds = [...new Set(filter.kinds ?? [])];
  const byKind = kinds.length
    ? sql`activity.action IN (${actionList(MAIL_ACTIVITY_FEED_ACTIONS)})
      AND (${kinds.map(kindCondition).reduce((left, right) => sql`${left} OR ${right}`)})`
    : sql`TRUE`;
  const byActor = filter.actorId ? sql`activity.actor_id = ${filter.actorId}::uuid` : sql`TRUE`;
  const principal = filter.concernsPrincipalId ?? null;
  const concerns = principal
    ? sql`(activity.actor_id = ${principal}::uuid
        OR ${assigneesAt("before")} @> ${JSON.stringify([principal])}::jsonb
        OR ${assigneesAt("after")} @> ${JSON.stringify([principal])}::jsonb
        OR EXISTS (
          SELECT 1 FROM mail.conversation_assignees concerned
          WHERE concerned.conversation_id = activity.conversation_id AND concerned.principal_id = ${principal}::uuid
        ))`
    : sql`TRUE`;
  return sql`(${byKind}) AND ${byActor} AND ${concerns}`;
};
