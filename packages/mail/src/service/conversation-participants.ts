import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { conversationVisibleTo, messageVisibleTo, requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { isUnsentOutboundMessage } from "./conversation-timeline";

/** People a conversation row names, first to write first; the list's "Participants" stack shows a few, its tooltip more. */
export const MAIL_ROW_PARTICIPANT_LIMIT = 10;

/**
 * Someone who wrote in a conversation. `kind` names a team member who sent through Mail, a service account or a
 * workflow; it is left out for an address, such as an external sender or a reply sent from another mail program.
 */
export type MailConversationParticipant = { name: string; kind?: "user" | "service_account" | "workflow" };

export type MailConversationParticipants = { people: MailConversationParticipant[]; count: number };

/**
 * Who wrote in each of these conversations, read only from the messages the request may see: the sender of each
 * message, or for a message Mail sent, the person, service account or workflow whose command sent it. Each person
 * counts once; at most `MAIL_ROW_PARTICIPANT_LIMIT` are named per conversation, with the full count. One statement
 * covers the whole page after it is chosen.
 */
export const listConversationParticipants = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationIds: readonly string[];
}): Promise<Result<Map<string, MailConversationParticipants>>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const conversationIds = [...new Set(params.conversationIds)].sort();
  if (conversationIds.length === 0) return ok(new Map());
  if (conversationIds.length > 100) return fail(err.badInput("At most 100 conversations can be loaded at once"));
  const rows = await sql<{ conversation_id: string; kind: MailConversationParticipant["kind"] | null; name: string; total: number }[]>`
    WITH writers AS (
      SELECT
        cm.conversation_id,
        COALESCE(writer.actor_kind || ':' || writer.actor_id::text, 'address:' || sender.normalized_email) AS key,
        writer.actor_kind AS kind,
        COALESCE(writer.name, sender.label) AS name,
        mc.internal_date,
        mc.id AS message_id
      FROM mail.conversations c
      JOIN mail.conversation_messages cm ON cm.conversation_id = c.id
      JOIN mail.message_contents mc ON mc.id = cm.message_id
      LEFT JOIN LATERAL (
        SELECT
          command.actor_kind,
          command.actor_id,
          COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name, actor_workflow.name) AS name
        FROM mail.outbox_submissions submission
        JOIN mail.commands command ON command.id = submission.command_id
        LEFT JOIN auth.users actor_user ON command.actor_kind = 'user' AND actor_user.id = command.actor_id
        LEFT JOIN auth.service_accounts actor_service
          ON command.actor_kind = 'service_account' AND actor_service.id = command.actor_id
        LEFT JOIN workflows.version actor_workflow_version
          ON command.actor_kind = 'workflow' AND actor_workflow_version.id = command.actor_id
        LEFT JOIN workflows.workflow actor_workflow ON actor_workflow.id = actor_workflow_version.workflow_id
        WHERE submission.message_id = mc.id
          AND command.actor_kind IN ('user', 'service_account', 'workflow')
          AND command.actor_id IS NOT NULL
        LIMIT 1
      ) writer ON true
      LEFT JOIN LATERAL (
        SELECT address.normalized_email, COALESCE(NULLIF(address.display_name, ''), address.email) AS label
        FROM mail.message_addresses address
        WHERE address.message_id = mc.id AND address.role = 'from'
        ORDER BY address.position
        LIMIT 1
      ) sender ON true
      WHERE c.mailbox_id = ${params.mailboxId}::uuid
        AND c.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb))
        AND ${conversationVisibleTo(allowed.data, sql`c.id`)}
        AND ${messageVisibleTo(allowed.data, sql`mc.id`)}
        AND NOT ${isUnsentOutboundMessage(sql`mc.id`)}
        AND COALESCE(writer.name, sender.label) IS NOT NULL
    ),
    people AS (
      SELECT
        conversation_id,
        key,
        (array_agg(kind))[1] AS kind,
        -- The name from their newest message, as the reader shows it.
        (array_agg(name ORDER BY internal_date DESC, message_id DESC))[1] AS name,
        min(internal_date) AS first_at
      FROM writers
      GROUP BY conversation_id, key
    ),
    ranked AS (
      SELECT
        conversation_id,
        kind,
        name,
        count(*) OVER (PARTITION BY conversation_id)::int AS total,
        row_number() OVER (PARTITION BY conversation_id ORDER BY first_at, key) AS position
      FROM people
    )
    SELECT conversation_id, kind, name, total
    FROM ranked
    WHERE position <= ${MAIL_ROW_PARTICIPANT_LIMIT}
    ORDER BY conversation_id, position
  `;
  const byConversation = new Map<string, MailConversationParticipants>();
  for (const row of rows) {
    const current = byConversation.get(row.conversation_id) ?? { people: [], count: row.total };
    current.people.push(row.kind ? { name: row.name, kind: row.kind } : { name: row.name });
    byConversation.set(row.conversation_id, current);
  }
  return ok(byConversation);
};
