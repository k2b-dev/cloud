import { sql } from "bun";

type SqlClient = typeof sql;
type SqlFragment = Bun.SQL.Query<unknown>;

/**
 * Outbox states of a message that belongs to its conversation's timeline. The undo window is the
 * moment right after someone chose Send, so the reply shows at once. A reply waiting for a later
 * send time, a failed send, and a cancelled or unsent one have not reached anyone: they neither
 * date the conversation nor count as newer than mail that arrives meanwhile.
 */
const TIMELINE_OUTBOX_STATES = [
  "undo_window",
  "sending",
  "accepted",
  "sent_sync_pending",
  "sent",
  "unknown",
  "reconciled_accepted",
  "needs_attention",
];

/**
 * Whether a message counts for its conversation's work state, date, subject, and participants:
 * a completely loaded message, or an outgoing one Mail sends or has sent.
 */
export const isTimelineMessage = (message: { id: SqlFragment; hydrationStatus: SqlFragment }): SqlFragment => sql`(
  ${message.hydrationStatus} = 'complete'
  OR EXISTS (
    SELECT 1
    FROM mail.outbox_submissions timeline_outbox
    WHERE timeline_outbox.message_id = ${message.id}
      AND timeline_outbox.state IN (SELECT value FROM jsonb_array_elements_text(${TIMELINE_OUTBOX_STATES}::jsonb))
  )
)`;

/**
 * Whether a message is an outgoing one that has not reached anyone, such as a reply scheduled for
 * later. A conversation row previews its newest message without it, as the timeline dates it.
 */
export const isUnsentOutboundMessage = (messageId: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.outbox_submissions unsent_outbox
  WHERE unsent_outbox.message_id = ${messageId}
    AND unsent_outbox.state NOT IN (SELECT value FROM jsonb_array_elements_text(${TIMELINE_OUTBOX_STATES}::jsonb))
)`;

/**
 * Whether a message's send needs attention: it failed, its outcome is unknown, the provider left it
 * unsent, or a scheduled retry follows an error. Send problems lists exactly these messages, and
 * conversations that contain one.
 */
export const hasSendProblem = (messageId: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.outbox_submissions problem_outbox
  WHERE problem_outbox.message_id = ${messageId}
    AND (
      (problem_outbox.state = 'scheduled' AND problem_outbox.last_error_code IS NOT NULL)
      OR problem_outbox.state IN ('failed', 'unknown', 'reconciled_unsent', 'needs_attention')
    )
)`;

/**
 * Whether mail reached a sent message's conversation after someone chose Send, such as an answer
 * that arrived while a reply waited for its send time. The reply was written without that mail, so
 * sending it does not answer it. Both times are Mail's own clock: when the send was committed and
 * when Mail first stored the received message.
 */
export const isMailReceivedSinceSend = (messageId: SqlFragment): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.outbox_submissions send_outbox
  JOIN mail.conversation_messages send_link ON send_link.message_id = send_outbox.message_id
  JOIN mail.conversations send_conversation ON send_conversation.id = send_link.conversation_id
  JOIN mail.conversation_messages later_link ON later_link.conversation_id = send_link.conversation_id
  JOIN mail.message_contents later ON later.id = later_link.message_id
  WHERE send_outbox.message_id = ${messageId}
    AND later.created_at > send_outbox.created_at
    AND NOT EXISTS (
      SELECT 1
      FROM mail.message_addresses later_sender
      JOIN mail.sender_identities later_identity
        ON later_identity.mailbox_id = send_conversation.mailbox_id
       AND lower(later_identity.from_address) = later_sender.normalized_email
      WHERE later_sender.message_id = later.id AND later_sender.role = 'from'
    )
)`;

/**
 * Recomputes a conversation's date, subject, and participant summary from its timeline messages
 * and reports whether any of them changed. A conversation without any, such as one that holds only
 * a scheduled reply, keeps its values. It first takes the row lock its UPDATE needs anyway, so the
 * recomputation reads what a concurrent hydration of the conversation committed instead of
 * overwriting it with older values.
 */
export const refreshConversationTimeline = async (db: SqlClient, conversationId: string): Promise<boolean> => {
  await db`SELECT id FROM mail.conversations WHERE id = ${conversationId}::uuid FOR NO KEY UPDATE`;
  const changed = await db<{ id: string }[]>`
    WITH classified AS (
      SELECT
        message.id AS message_id,
        message.subject,
        message.internal_date,
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = conversation.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = message.id AND sender.role = 'from'
        ) AS outbound
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE conversation.id = ${conversationId}::uuid
        AND ${isTimelineMessage({ id: sql`message.id`, hydrationStatus: sql`message.hydration_status` })}
    ),
    timeline AS (
      SELECT
        MAX(internal_date) AS latest_message_at,
        MAX(internal_date) FILTER (WHERE NOT outbound) AS latest_inbound_at,
        MAX(internal_date) FILTER (WHERE outbound) AS latest_outbound_at
      FROM classified
    ),
    latest AS (
      SELECT message_id, subject, outbound
      FROM classified
      ORDER BY internal_date DESC, message_id DESC
      LIMIT 1
    ),
    participant_labels AS (
      SELECT DISTINCT ON (address.normalized_email)
        address.normalized_email,
        COALESCE(NULLIF(address.display_name, ''), address.email) AS label
      FROM mail.message_addresses address
      JOIN latest ON latest.message_id = address.message_id
      WHERE (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
         OR (NOT latest.outbound AND address.role = 'from')
      ORDER BY address.normalized_email, address.position
    ),
    participants AS (
      SELECT COALESCE(string_agg(label, ', ' ORDER BY label), '') AS summary
      FROM participant_labels
    )
    UPDATE mail.conversations conversation
    SET
      subject = latest.subject,
      participant_summary = participants.summary,
      latest_message_at = timeline.latest_message_at,
      latest_inbound_at = timeline.latest_inbound_at,
      latest_outbound_at = timeline.latest_outbound_at
    FROM timeline, latest, participants
    WHERE conversation.id = ${conversationId}::uuid
      AND (
        conversation.subject,
        conversation.participant_summary,
        conversation.latest_message_at,
        conversation.latest_inbound_at,
        conversation.latest_outbound_at
      ) IS DISTINCT FROM (
        latest.subject,
        participants.summary,
        timeline.latest_message_at,
        timeline.latest_inbound_at,
        timeline.latest_outbound_at
      )
    RETURNING conversation.id
  `;
  return changed.length > 0;
};
