import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { withShortIdDb } from "../lib/short-id";
import { normalizeEmailAddress } from "./address-normalization";
import { sha256Json } from "./canonical";
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

const ensureConversation = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string | null;
  snapshot: OutboundDraftSnapshot;
  internalDate: Date;
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
      ${params.internalDate},
      ${params.internalDate},
      'needs_action'
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
    internalDate: params.internalDate,
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
  if (params.conversationId) {
    await params.db`
      UPDATE mail.conversations
      SET
        subject = ${params.snapshot.subject},
        participant_summary = ${participantSummary(params.snapshot)},
        latest_outbound_at = GREATEST(COALESCE(latest_outbound_at, ${params.internalDate}), ${params.internalDate}),
        latest_message_at = GREATEST(latest_message_at, ${params.internalDate}),
        revision = revision + 1,
        updated_at = now()
      WHERE id = ${conversationId}::uuid
    `;
  }
  await params.db`
    UPDATE mail.outbox_submissions
    SET message_id = ${message.id}::uuid
    WHERE id = ${params.outboxId}::uuid
  `;
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
 * references with every other one of the folder and imports the copy again.
 */
export const recordSentCopyPlacement = async (
  db: SqlClient,
  params: { outboxId: string; bindingId: string; folderId: string; uids: readonly number[] },
): Promise<void> => {
  if (params.uids.length === 0) return;
  await db`
    WITH target AS (
      SELECT outbox.message_id, folder_ref.uid_validity
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
    )
    INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
    SELECT refs.id, ${params.folderId}::uuid, refs.message_id, ARRAY['\\Seen']::text[]
    FROM refs
    ON CONFLICT (remote_message_ref_id) DO NOTHING
  `;
};

export const loadOutboundProjectionByOutbox = async (db: SqlClient, outboxId: string): Promise<OutboundMessageProjection | null> => {
  const [projection] = await db<OutboundMessageProjection[]>`
    SELECT
      outbox.id AS "outboxId",
      outbox.mailbox_id AS "mailboxId",
      outbox.message_id AS "messageId",
      link.conversation_id AS "conversationId"
    FROM mail.outbox_submissions outbox
    JOIN mail.conversation_messages link ON link.message_id = outbox.message_id
    WHERE outbox.id = ${outboxId}::uuid
  `;
  return projection ?? null;
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
  await db`
    WITH classified AS (
      SELECT
        message.id,
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
      WHERE conversation.id = ${projection.conversation_id}::uuid
    ),
    timeline AS (
      SELECT
        MAX(internal_date) AS latest_message_at,
        MAX(internal_date) FILTER (WHERE NOT outbound) AS latest_inbound_at,
        MAX(internal_date) FILTER (WHERE outbound) AS latest_outbound_at
      FROM classified
    ),
    latest AS (
      SELECT id, subject, outbound
      FROM classified
      ORDER BY internal_date DESC, id DESC
      LIMIT 1
    ),
    participant_labels AS (
      SELECT DISTINCT ON (address.normalized_email)
        address.normalized_email,
        COALESCE(NULLIF(address.display_name, ''), address.email) AS label
      FROM mail.message_addresses address
      JOIN latest ON latest.id = address.message_id
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
      latest_outbound_at = timeline.latest_outbound_at,
      revision = conversation.revision + 1,
      updated_at = now()
    FROM timeline, latest, participants
    WHERE conversation.id = ${projection.conversation_id}::uuid
  `;
};
