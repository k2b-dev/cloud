import { sql } from "@k2b/cloud";
import { conversationVisibleTo, type MailboxAccess } from "./access";
import { isUnassignedConversation, listLapsedAssignees } from "./collaborators";
import { hasSendProblem } from "./conversation-timeline";
import { loadAggregatedViewScope, staysInAggregatedViewsAggregate } from "./folder-display";
import { isFollowUpMessage } from "./follow-up-scope";
import type { ConversationViewCounts } from "./messages";

/** The authoritative query, also used to measure the prepared statement on a fixture transaction. */
export const queryConversationViewCounts = async (
  params: {
    mailboxId: string;
    currentUserId: string;
    visibility: MailboxAccess;
  },
  db: typeof sql,
): Promise<ConversationViewCounts> => {
  const [lapsedAssignees, aggregatedScope] = await Promise.all([
    listLapsedAssignees({ mailboxIds: [params.mailboxId], db }),
    loadAggregatedViewScope([params.mailboxId], db),
  ]);
  const [row] = await db<
    {
      needs_action: number;
      mine: number;
      unassigned: number;
      waiting: number;
      done: number;
      snoozed: number;
      send_problems: number;
      recently_active: number;
      kept: number;
    }[]
  >`
      SELECT
        COUNT(*) FILTER (
          WHERE scope.aggregated
            AND scope.follow_up
            AND scope.work_status = 'needs_action'
            AND (scope.snoozed_until IS NULL OR scope.snoozed_until <= now())
        )::int AS needs_action,
        COUNT(*) FILTER (
          WHERE scope.follow_up
            AND EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = scope.id AND a.principal_id = ${params.currentUserId}::uuid)
            AND scope.work_status <> 'done'
            AND (scope.snoozed_until IS NULL OR scope.snoozed_until <= now())
        )::int AS mine,
        COUNT(*) FILTER (
          WHERE scope.aggregated
            AND scope.follow_up
            AND ${isUnassignedConversation(lapsedAssignees, sql`scope`)}
            AND scope.work_status <> 'done'
            AND (scope.snoozed_until IS NULL OR scope.snoozed_until <= now())
        )::int AS unassigned,
        COUNT(*) FILTER (
          WHERE scope.aggregated
            AND scope.follow_up
            AND scope.work_status = 'waiting'
            AND (scope.snoozed_until IS NULL OR scope.snoozed_until <= now())
        )::int AS waiting,
        COUNT(*) FILTER (WHERE scope.aggregated AND scope.work_status = 'done')::int AS done,
        COUNT(*) FILTER (WHERE scope.aggregated AND scope.follow_up AND scope.snoozed_until > now())::int AS snoozed,
        COUNT(*) FILTER (WHERE scope.send_problem)::int AS send_problems,
        COUNT(*) FILTER (WHERE scope.aggregated)::int AS recently_active,
        (SELECT COUNT(*)::int FROM mail.conversation_keeps keep
          WHERE keep.mailbox_id = ${params.mailboxId}::uuid AND ${conversationVisibleTo(params.visibility, sql`keep.conversation_id`)}) AS kept
      FROM (
        SELECT
          c.id,
          c.mailbox_id,
          c.work_status,
          c.snoozed_until,
          bool_or(${isFollowUpMessage(sql`placement`, sql`outbox.id IS NOT NULL`)}) AS follow_up,
          bool_or(${hasSendProblem(sql`link.message_id`)}) AS send_problem,
          ${staysInAggregatedViewsAggregate(sql`placement.folder_id`, aggregatedScope)} AS aggregated
        FROM mail.conversations c
        JOIN mail.conversation_messages link ON link.conversation_id = c.id
        LEFT JOIN mail.message_placements placement
          ON placement.message_id = link.message_id
         AND placement.deleted_at IS NULL
        LEFT JOIN mail.outbox_submissions outbox
          ON outbox.message_id = link.message_id
         AND outbox.state <> 'cancelled'
        WHERE c.mailbox_id = ${params.mailboxId}::uuid
      AND ${conversationVisibleTo(params.visibility, sql`c.id`)}
        GROUP BY c.id
        -- A conversation counts while one of its messages is filed somewhere or on its way out.
        HAVING bool_or(placement.message_id IS NOT NULL OR outbox.id IS NOT NULL)
      ) scope
    `;
  return {
    needs_action: row?.needs_action ?? 0,
    mine: row?.mine ?? 0,
    unassigned: row?.unassigned ?? 0,
    waiting: row?.waiting ?? 0,
    done: row?.done ?? 0,
    snoozed: row?.snoozed ?? 0,
    send_problems: row?.send_problems ?? 0,
    recently_active: row?.recently_active ?? 0,
    kept: row?.kept ?? 0,
  };
};
