import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { withShortIdDb } from "../lib/short-id";
import { normalizeEmailAddress } from "./address-normalization";
import { sha256Json } from "./canonical";
import { refreshConversationTimeline } from "./conversation-timeline";
import { enqueueMailInvalidation } from "./live";
import { normalizeMailSubject } from "./message-threading";
import type { OutboundDraftSnapshot } from "./outbound-mime";
import { splitSearchText } from "./search-chunks";

type SqlClient = typeof sql;

export type OutboundMessageProjection = {
  outboxId: string;
  mailboxId: string;
  messageId: string;
  conversationId: string;
};

const addressRows = (messageId: string, snapshot: OutboundDraftSnapshot) => {
  const addresses = {
    from: [snapshot.from],
    reply_to: snapshot.replyTo ? [{ name: null, address: snapshot.replyTo }] : [],
    to: snapshot.to,
    cc: snapshot.cc,
    bcc: snapshot.bcc,
  };
  return Object.entries(addresses).flatMap(([role, values]) =>
    values.map((address, position) => ({
      message_id: messageId,
      role,
      position,
      display_name: address.name?.trim() || null,
      email: address.address,
      normalized_email: normalizeEmailAddress(address.address) ?? address.address.trim().toLowerCase(),
    })),
  );
};

const participantSummary = (snapshot: OutboundDraftSnapshot): string => {
  const participants = new Map<string, string>();
  for (const address of [...snapshot.to, ...snapshot.cc, ...snapshot.bcc]) {
    const key = normalizeEmailAddress(address.address) ?? address.address.trim().toLowerCase();
    if (!participants.has(key)) participants.set(key, address.name?.trim() || address.address);
  }
  return [...participants.values()].slice(0, 20).join(", ");
};

/**
 * A new message starts a conversation that waits for an answer: the team has nothing to do until
 * someone replies. Until the message joins the timeline, the conversation dates from now rather
 * than from a later send time.
 */
const ensureConversation = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string | null;
  snapshot: OutboundDraftSnapshot;
}): Promise<string> => {
  if (params.conversationId) {
    const [conversation] = await params.db<{ id: string }[]>`
      SELECT id
      FROM mail.conversations
      WHERE id = ${params.conversationId}::uuid
        AND mailbox_id = ${params.mailboxId}::uuid
      FOR UPDATE
    `;
    if (!conversation) throw new Error("Outbound draft conversation does not exist");
    return conversation.id;
  }
  const conversationRows = await withShortIdDb(
    params.db,
    "conversation",
    (db, shortId) => db<{ id: string }[]>`
    INSERT INTO mail.conversations (
      short_id,
      mailbox_id,
      subject,
      participant_summary,
      latest_outbound_at,
      latest_message_at,
      work_status
    )
    VALUES (
      ${shortId},
      ${params.mailboxId}::uuid,
      ${params.snapshot.subject},
      ${participantSummary(params.snapshot)},
      NULL,
      now(),
      'waiting'
    )
    RETURNING id
  `,
  );
  const [conversation] = conversationRows;
  if (!conversation) throw new Error("Outbound conversation insert returned no row");
  return conversation.id;
};

const insertAttachments = async (params: { db: SqlClient; messageId: string; snapshot: OutboundDraftSnapshot }): Promise<void> => {
  for (const [index, attachment] of params.snapshot.attachments.entries()) {
    const [part] = await params.db<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id,
        part_path,
        content_type,
        disposition,
        filename,
        size_bytes,
        blob_id,
        hydration_status
      )
      VALUES (
        ${params.messageId}::uuid,
        ${`outbound-attachment-${index + 1}`},
        ${attachment.contentType},
        'attachment',
        ${attachment.filename},
        ${attachment.byteLength},
        ${attachment.blobId}::uuid,
        'complete'
      )
      RETURNING id
    `;
    if (!part) throw new Error("Outbound message part insert returned no row");
    await withShortIdDb(
      params.db,
      "attachment",
      (db, shortId) => db`
      INSERT INTO mail.attachments (
        short_id,
        message_id,
        part_id,
        filename,
        content_type,
        disposition,
        checksum,
        size_bytes,
        blob_id
      )
      VALUES (
        ${shortId},
        ${params.messageId}::uuid,
        ${part.id}::uuid,
        ${attachment.filename},
        ${attachment.contentType},
        'attachment',
        ${attachment.contentHash},
        ${attachment.byteLength},
        ${attachment.blobId}::uuid
      )
    `,
    );
  }
};

const insertSearchChunks = async (params: { db: SqlClient; mailboxId: string; messageId: string; plainText: string }): Promise<void> => {
  const chunks = splitSearchText(params.plainText);
  for (const [position, chunk] of chunks.entries()) {
    await params.db`
      INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      VALUES (
        ${params.messageId}::uuid,
        ${params.mailboxId}::uuid,
        ${position},
        to_tsvector('simple'::regconfig, ${chunk})
      )
    `;
  }
};

export const materializeOutboundMessage = async (params: {
  db: SqlClient;
  mailboxId: string;
  outboxId: string;
  stableMessageId: string;
  conversationId: string | null;
  snapshot: OutboundDraftSnapshot;
  internalDate: Date;
  byteLength: number;
}): Promise<OutboundMessageProjection> => {
  const plainText = params.snapshot.renderedText ?? params.snapshot.body;
  const messageRows = await withShortIdDb(
    params.db,
    "message",
    (db, shortId) => db<{ id: string }[]>`
    INSERT INTO mail.message_contents (
      short_id,
      mailbox_id,
      message_id,
      in_reply_to,
      reference_ids,
      subject,
      normalized_subject,
      internal_date,
      size_bytes,
      plain_text,
      sanitized_html,
      content_hash,
      hydration_status
    )
    VALUES (
      ${shortId},
      ${params.mailboxId}::uuid,
      ${params.stableMessageId},
      ${params.snapshot.inReplyTo},
      ${toPgTextArray(params.snapshot.references)}::text[],
      ${params.snapshot.subject},
      ${normalizeMailSubject(params.snapshot.subject)},
      ${params.internalDate},
      ${params.byteLength},
      ${plainText || null},
      ${params.snapshot.renderedHtml ?? null},
      ${sha256Json({ kind: "outbox", outboxId: params.outboxId })},
      'body'
    )
    RETURNING id
  `,
  );
  const [message] = messageRows;
  if (!message) throw new Error("Outbound message insert returned no row");

  const addresses = addressRows(message.id, params.snapshot);
  if (addresses.length > 0) {
    await params.db`
      INSERT INTO mail.message_addresses ${sql(addresses, "message_id", "role", "position", "display_name", "email", "normalized_email")}
    `;
  }
  await insertAttachments({ db: params.db, messageId: message.id, snapshot: params.snapshot });
  await insertSearchChunks({ db: params.db, mailboxId: params.mailboxId, messageId: message.id, plainText });

  const conversationId = await ensureConversation({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    snapshot: params.snapshot,
  });
  await params.db`
    INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
    VALUES (
      ${conversationId}::uuid,
      ${message.id}::uuid,
      ${params.internalDate.getTime()},
      'outbox'
    )
  `;
  await params.db`
    UPDATE mail.outbox_submissions
    SET message_id = ${message.id}::uuid
    WHERE id = ${params.outboxId}::uuid
  `;
  await refreshConversationTimeline(params.db, conversationId);
  if (params.conversationId) {
    await params.db`UPDATE mail.conversations SET revision = revision + 1, updated_at = now() WHERE id = ${conversationId}::uuid`;
  }
  return { outboxId: params.outboxId, mailboxId: params.mailboxId, messageId: message.id, conversationId };
};

/**
 * A confirmed send carries the Date header Mail wrote into the message, so the local copy
 * shows when it was sent before any provider copy is synchronized.
 */
export const recordOutboundSentAt = async (db: SqlClient, outboxId: string): Promise<void> => {
  await db`
    UPDATE mail.message_contents message
    SET sent_at = COALESCE(message.sent_at, outbox.mime_date)
    FROM mail.outbox_submissions outbox
    WHERE outbox.id = ${outboxId}::uuid
      AND message.id = outbox.message_id
  `;
};

/**
 * Places the sent message in the sender's Sent folder at the UIDs where the outbox found its
 * provider copy, so Sent shows it without waiting for that folder's next sync. The sync later
 * reaches the same UIDs and keeps these references. UIDVALIDITY is the one the binding last
 * verified for the folder; if the provider has changed it since, the next sync retires these
 * references with every other one of the folder and imports the copy again. Open views learn
 * about a new placement through a live invalidation committed with it.
 */
export const recordSentCopyPlacement = async (
  db: SqlClient,
  params: { outboxId: string; bindingId: string; folderId: string; uids: readonly number[] },
): Promise<void> => {
  if (params.uids.length === 0) return;
  const placed = await db<{ mailbox_id: string; conversation_id: string | null }[]>`
    WITH target AS (
      SELECT outbox.message_id, outbox.mailbox_id, folder_ref.uid_validity
      FROM mail.outbox_submissions outbox
      JOIN mail.binding_folder_refs folder_ref
        ON folder_ref.binding_id = ${params.bindingId}::uuid
       AND folder_ref.folder_id = ${params.folderId}::uuid
      WHERE outbox.id = ${params.outboxId}::uuid
        AND outbox.message_id IS NOT NULL
        AND folder_ref.uid_validity IS NOT NULL
    ),
    refs AS (
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, connector_ref)
      SELECT ${params.folderId}::uuid, target.message_id, target.uid_validity, remote.uid, ${{ source: "outbox" }}::jsonb
      FROM target
      CROSS JOIN unnest(${toPgTextArray(params.uids.map(String))}::numeric[]) AS remote(uid)
      ON CONFLICT (folder_id, uid_validity, uid) DO NOTHING
      RETURNING id, message_id
    ),
    placements AS (
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      SELECT refs.id, ${params.folderId}::uuid, refs.message_id, ARRAY['\\Seen']::text[]
      FROM refs
      ON CONFLICT (remote_message_ref_id) DO NOTHING
      RETURNING message_id
    )
    SELECT DISTINCT target.mailbox_id, link.conversation_id
    FROM placements
    JOIN target ON target.message_id = placements.message_id
    LEFT JOIN mail.conversation_messages link ON link.message_id = placements.message_id
  `;
  for (const row of placed) await enqueueMailInvalidation(db, { mailboxId: row.mailbox_id, conversationId: row.conversation_id });
};

export const removeUnsentOutboundMessage = async (db: SqlClient, outboxId: string): Promise<void> => {
  const [projection] = await db<{ message_id: string; conversation_id: string }[]>`
    SELECT outbox.message_id, link.conversation_id
    FROM mail.outbox_submissions outbox
    JOIN mail.conversation_messages link ON link.message_id = outbox.message_id
    WHERE outbox.id = ${outboxId}::uuid
    FOR UPDATE OF outbox
  `;
  if (!projection) return;
  const [removed] = await db<{ id: string }[]>`
    DELETE FROM mail.message_contents message
    WHERE message.id = ${projection.message_id}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM mail.remote_message_refs remote_ref
        WHERE remote_ref.message_id = message.id
      )
    RETURNING message.id
  `;
  if (!removed) throw new Error("A provider-backed outbound message cannot be removed as unsent");

  const [remaining] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM mail.conversation_messages
    WHERE conversation_id = ${projection.conversation_id}::uuid
  `;
  if ((remaining?.count ?? 0) === 0) {
    await db`DELETE FROM mail.conversations WHERE id = ${projection.conversation_id}::uuid`;
    return;
  }
  await refreshConversationTimeline(db, projection.conversation_id);
  await db`UPDATE mail.conversations SET revision = revision + 1, updated_at = now() WHERE id = ${projection.conversation_id}::uuid`;
};

/**
 * Whether the folder sync has placed a copy of the sent message in its sender's Sent folder.
 * Only the provider stores a copy there before Mail knows that SMTP accepted the message, so
 * such a copy proves the acceptance just like one the provider's search returns.
 */
export const hasSyncedSentCopy = async (db: SqlClient, outboxId: string): Promise<boolean> => {
  const [found] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.outbox_submissions outbox
      JOIN mail.sender_identities identity ON identity.id = outbox.sender_identity_id
      JOIN mail.remote_message_refs remote_ref
        ON remote_ref.message_id = outbox.message_id
       AND remote_ref.folder_id = identity.sent_folder_id
       AND remote_ref.stale_at IS NULL
      WHERE outbox.id = ${outboxId}::uuid
    ) AS exists
  `;
  return found?.exists === true;
};

/**
 * Hands a send whose outcome Mail could not prove back to reconciliation once a copy shows up
 * in the sender's Sent folder, for example after the provider's search lagged behind its own
 * Sent folder. `sentCopyFolderId` is the folder a sync is placing the message in right now.
 *
 * The delivery is locked before the message is written, the order every send transition
 * uses, so a sync that places the copy while the send is being given up on either waits for
 * that decision and reopens it, or commits first and the decision sees the copy.
 * Returns whether the send went back to reconciliation.
 */
export const reopenUnprovenSendWithSentCopy = async (
  db: SqlClient,
  params: { messageId: string; sentCopyFolderId?: string },
): Promise<boolean> => {
  const [outbox] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.outbox_submissions
    WHERE message_id = ${params.messageId}::uuid AND state IN ('unknown', 'needs_attention')
    FOR UPDATE
  `;
  if (!outbox) return false;
  const [reopened] = await db<{ id: string }[]>`
    WITH unproven AS (
      SELECT outbox.id, outbox.command_id
      FROM mail.outbox_submissions outbox
      JOIN mail.commands command ON command.id = outbox.command_id AND command.state = 'needs_attention'
      JOIN mail.sender_identities identity ON identity.id = outbox.sender_identity_id
      WHERE outbox.id = ${outbox.id}::uuid
        -- Mail gave up proving the outcome; a partial acceptance is a known outcome.
        AND outbox.state = 'needs_attention'
        AND outbox.accepted_at IS NULL
        AND outbox.last_error_code IS DISTINCT FROM 'SMTP_PARTIAL_ACCEPTANCE'
        AND (
          identity.sent_folder_id = ${params.sentCopyFolderId ?? null}::uuid
          OR EXISTS (
            SELECT 1
            FROM mail.remote_message_refs remote_ref
            WHERE remote_ref.message_id = outbox.message_id
              AND remote_ref.folder_id = identity.sent_folder_id
              AND remote_ref.stale_at IS NULL
          )
        )
    ),
    reopened_command AS (
      UPDATE mail.commands command
      SET state = 'ambiguous', finished_at = NULL, worker_heartbeat_at = NULL, updated_at = now()
      FROM unproven
      WHERE command.id = unproven.command_id
      RETURNING command.id
    )
    UPDATE mail.outbox_submissions outbox
    SET state = 'unknown', updated_at = now()
    FROM unproven
    JOIN reopened_command ON reopened_command.id = unproven.command_id
    WHERE outbox.id = unproven.id
    RETURNING outbox.id
  `;
  return Boolean(reopened);
};
