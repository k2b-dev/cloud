import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type MailConversationContext,
  type MailConversationContextQuery,
  type MailConversationSpaceCreateInput,
  mailConversationParticipantSchema,
  relatedConversationReasonSchema,
  type RelatedConversationSummary,
  type RelatedMailPage,
} from "../contracts";
import {
  type AppIntegrationFailure,
  type AppIntegrationRequest,
  createSpaceItemForResource,
  findSpaceItemsByResource,
  getCalendarSpace,
  linkSpaceItemResource,
  resolveContacts,
  searchSpaceItems,
  unlinkSpaceItemResource,
} from "./app-integrations";
import type { MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { normalizeMailSubject } from "./message-threading";
import { publicIds, requirePublicId } from "./public-resources";

type SqlClient = typeof sql;

type ConversationParticipant = {
  email: string;
  displayName: string | null;
};

type ConversationProjection = {
  subject: string;
  participants: ConversationParticipant[];
};

type HistoryCursor = { version: 1; date: string; id: string };
type AppDependencyFailure = Omit<AppIntegrationFailure, "status"> & { status: 503 };

const integrationFailure = (result: AppIntegrationFailure) => {
  if (result.status === 503) return { ...result, status: 503 as const };
  if (result.status === 400) return fail(err.badInput(result.message));
  if (result.status === 403) return fail(err.forbidden(result.message));
  if (result.status === 404) return fail(err.notFound(result.message));
  if (result.status === 409) return fail(err.conflict(result.message));
  return fail(err.internal(result.message));
};

const historyCursorSchema = z.object({ version: z.literal(1), date: z.string().datetime(), id: z.uuid() }).strict();

const encodeHistoryCursor = (cursor: HistoryCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeHistoryCursor = (value?: string): Result<HistoryCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = historyCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid related Mail cursor"));
  } catch {
    return fail(err.badInput("Invalid related Mail cursor"));
  }
};

const loadConversationProjection = async (
  mailboxId: string,
  conversationId: string,
  db: SqlClient = sql,
): Promise<ConversationProjection | null> => {
  const [row] = await db<Array<{ subject: string; participants: unknown }>>`
    SELECT conversation.subject, COALESCE(participants.items, '[]'::jsonb) AS participants
    FROM mail.conversations conversation
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT('email', participant.email, 'displayName', participant.display_name)
        ORDER BY participant.last_seen_at DESC, participant.email
      ) AS items
      FROM (
        SELECT deduplicated.email, deduplicated.display_name, deduplicated.last_seen_at
        FROM (
          SELECT DISTINCT ON (address.normalized_email)
            address.normalized_email AS email,
            NULLIF(BTRIM(address.display_name), '') AS display_name,
            message.internal_date AS last_seen_at
          FROM mail.conversation_messages link
          JOIN mail.message_contents message ON message.id = link.message_id
          JOIN mail.message_addresses address ON address.message_id = link.message_id
          WHERE link.conversation_id = conversation.id
            AND address.role IN ('from', 'reply_to', 'to', 'cc', 'bcc')
            AND EXISTS (
              SELECT 1 FROM mail.message_placements placement
              WHERE placement.message_id = link.message_id AND placement.deleted_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mail.sender_identities identity
              WHERE identity.mailbox_id = conversation.mailbox_id
                AND address.normalized_email IN (
                  LOWER(BTRIM(identity.from_address)),
                  LOWER(BTRIM(COALESCE(identity.reply_to, '')))
                )
            )
          ORDER BY
            address.normalized_email,
            (NULLIF(BTRIM(address.display_name), '') IS NOT NULL) DESC,
            message.internal_date DESC,
            link.position DESC,
            address.role,
            address.position
        ) deduplicated
        ORDER BY deduplicated.last_seen_at DESC, deduplicated.email
        LIMIT 100
      ) participant
    ) participants ON true
    WHERE conversation.id = ${conversationId}::uuid AND conversation.mailbox_id = ${mailboxId}::uuid
  `;
  if (!row) return null;
  return {
    subject: row.subject,
    participants: z.array(mailConversationParticipantSchema).max(100).parse(row.participants),
  };
};

const requireConversationResource = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<{ ref: { type: "mail.conversation"; id: string }; label: string }>> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const conversation = await loadConversationProjection(params.mailboxId, params.conversationId);
  if (!conversation) return fail(err.notFound("Conversation"));
  const ids = await publicIds("conversations", [params.conversationId]);
  return ok({
    ref: { type: "mail.conversation", id: requirePublicId(ids, params.conversationId) },
    label: conversation.subject.trim().slice(0, 500) || "(No subject)",
  });
};

export const searchConversationSpaceItems = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  query: string;
}) => {
  const resource = await requireConversationResource(params);
  if (!resource.ok) return resource;
  const result = await searchSpaceItems(params.query, params.request);
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const getConversationSpace = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  spaceId: string;
}) => {
  const resource = await requireConversationResource(params);
  if (!resource.ok) return resource;
  const result = await getCalendarSpace(params.spaceId, params.request);
  if (!result.ok) return integrationFailure(result);
  return result.data.permission === "read" ? fail(err.forbidden("Write access to the selected Space is required")) : ok(result.data);
};

export const linkConversationSpaceItem = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  itemId: string;
}) => {
  const resource = await requireConversationResource(params);
  if (!resource.ok) return resource;
  const result = await linkSpaceItemResource({ itemId: params.itemId, reference: resource.data }, params.request);
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const unlinkConversationSpaceItem = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  itemId: string;
}) => {
  const resource = await requireConversationResource(params);
  if (!resource.ok) return resource;
  const result = await unlinkSpaceItemResource({ itemId: params.itemId, ref: resource.data.ref }, params.request);
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const createConversationSpaceItem = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  input: MailConversationSpaceCreateInput;
}) => {
  const resource = await requireConversationResource(params);
  if (!resource.ok) return resource;
  const { kind, ...input } = params.input;
  const result = await createSpaceItemForResource(kind, { ...input, references: [resource.data] }, params.request);
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const getConversationContext = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  query: MailConversationContextQuery;
}): Promise<Result<MailConversationContext>> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const conversation = await loadConversationProjection(params.mailboxId, params.conversationId);
  if (!conversation) return fail(err.notFound("Conversation"));
  const participantEmails = conversation.participants.map((participant) => participant.email);
  const conversationIds = await publicIds("conversations", [params.conversationId]);
  const publicConversationId = requirePublicId(conversationIds, params.conversationId);
  const [contacts, linkedSpaces] = await Promise.all([
    participantEmails.length === 0
      ? Promise.resolve({ ok: true as const, data: { items: [], matchedEmails: [], nextCursor: null } })
      : resolveContacts(
          {
            emails: participantEmails,
            cursor: params.query.contactsCursor,
            limit: params.query.contactsLimit,
          },
          params.request,
        ),
    findSpaceItemsByResource({ type: "mail.conversation", id: publicConversationId }, params.request),
  ]);

  return ok({
    conversationId: params.conversationId,
    participants: conversation.participants,
    contacts: contacts.ok
      ? {
          status: "ready",
          items: contacts.data.items,
          matchedEmails: contacts.data.matchedEmails,
          nextCursor: contacts.data.nextCursor,
        }
      : { status: "unavailable", items: [], matchedEmails: [], nextCursor: null },
    spaces: linkedSpaces.ok
      ? { status: "ready", items: linkedSpaces.data.items, truncated: linkedSpaces.data.truncated }
      : { status: "unavailable", items: [], truncated: false },
  });
};

export const listRelatedMail = async (params: {
  context: MailRequestContext;
  request: AppIntegrationRequest;
  mailboxId: string;
  conversationId: string;
  bookId: string;
  contactId: string;
  cursor?: string;
  limit: number;
}): Promise<Result<RelatedMailPage> | AppDependencyFailure> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const conversation = await loadConversationProjection(params.mailboxId, params.conversationId);
  if (!conversation) return fail(err.notFound("Conversation"));
  const participantEmails = conversation.participants.map((participant) => participant.email);
  if (participantEmails.length === 0) return fail(err.notFound("Contact"));
  const contact = await resolveContacts({ emails: participantEmails, contactIds: [params.contactId], limit: 1 }, params.request);
  if (!contact.ok) return { ...contact, status: 503 as const };
  const match = contact.data.items.find((item) => item.contactId === params.contactId && item.bookId === params.bookId);
  if (!match) return fail(err.notFound("Contact"));
  const cursor = decodeHistoryCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(params.limit, 1), 25);
  const rows = await sql<
    Array<{ id: string; subject: string; participant_summary: string; latest_message_at: Date; preview: string | null }>
  >`
    WITH address_matches AS MATERIALIZED (
      SELECT DISTINCT link.conversation_id
      FROM mail.message_addresses address
      JOIN mail.conversation_messages link ON link.message_id = address.message_id
      JOIN mail.message_contents message ON message.id = address.message_id
      WHERE address.normalized_email = ANY(${toPgTextArray(match.matchedEmails)}::text[])
        AND message.mailbox_id = ${params.mailboxId}::uuid
        AND EXISTS (
          SELECT 1 FROM mail.message_placements placement
          WHERE placement.message_id = message.id AND placement.deleted_at IS NULL
        )
    )
    SELECT
      conversation.id,
      conversation.subject,
      conversation.participant_summary,
      conversation.latest_message_at,
      latest.preview
    FROM address_matches match
    JOIN mail.conversations conversation ON conversation.id = match.conversation_id
    LEFT JOIN LATERAL (
      SELECT NULLIF(LEFT(BTRIM(COALESCE(message.plain_text, '')), 240), '') AS preview
      FROM mail.conversation_messages link
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE link.conversation_id = conversation.id
      ORDER BY message.internal_date DESC, message.id DESC
      LIMIT 1
    ) latest ON true
    WHERE conversation.mailbox_id = ${params.mailboxId}::uuid
      AND conversation.id <> ${params.conversationId}::uuid
      AND (${cursor.data?.id ?? null}::uuid IS NULL OR (conversation.latest_message_at, conversation.id) < (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
    ORDER BY conversation.latest_message_at DESC, conversation.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((row) => ({
    id: row.id,
    subject: row.subject,
    participantSummary: row.participant_summary,
    latestMessageAt: row.latest_message_at.toISOString(),
    preview: row.preview,
  }));
  const last = items.at(-1);
  return ok({
    items,
    nextCursor: hasMore && last ? encodeHistoryCursor({ version: 1, date: last.latestMessageAt, id: last.id }) : null,
  });
};

/**
 * Finds explainable, deterministic relations inside one authorized mailbox.
 * Calendar attachments are deliberately not considered: Mail does not persist
 * a stable parsed event identity today, so guessing from attachment contents
 * would make both ranking and authorization harder to reason about.
 */
export const listRelatedConversations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  limit: number;
}): Promise<Result<RelatedConversationSummary[]>> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const conversation = await loadConversationProjection(params.mailboxId, params.conversationId);
  if (!conversation) return fail(err.notFound("Conversation"));

  const participantEmails = conversation.participants.map((participant) => participant.email);
  const normalizedSubject = normalizeMailSubject(conversation.subject);
  if (participantEmails.length === 0 && normalizedSubject.length === 0) return ok([]);
  const limit = Math.min(Math.max(params.limit, 1), 10);
  // Each supported relation signal contributes at most one result-sized,
  // newest-first candidate window before any combined ranking work begins.
  const candidateLimitPerSignal = limit;

  const rows = await sql<
    Array<{
      id: string;
      subject: string;
      participant_summary: string;
      latest_message_at: Date;
      preview: string | null;
      reasons: unknown;
    }>
  >`
    WITH participant_candidates AS MATERIALIZED (
      SELECT
        conversation.id AS conversation_id,
        conversation.latest_message_at
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_addresses address ON address.message_id = link.message_id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE ${participantEmails.length > 0}
        AND conversation.mailbox_id = ${params.mailboxId}::uuid
        AND conversation.id <> ${params.conversationId}::uuid
        AND address.normalized_email = ANY(${toPgTextArray(participantEmails)}::text[])
        AND EXISTS (
          SELECT 1 FROM mail.message_placements placement
          WHERE placement.message_id = message.id AND placement.deleted_at IS NULL
        )
      GROUP BY conversation.id, conversation.latest_message_at
      ORDER BY conversation.latest_message_at DESC, conversation.id DESC
      LIMIT ${candidateLimitPerSignal}
    ), subject_candidates AS MATERIALIZED (
      SELECT
        conversation.id AS conversation_id,
        conversation.latest_message_at
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE ${normalizedSubject.length > 0}
        AND conversation.mailbox_id = ${params.mailboxId}::uuid
        AND conversation.id <> ${params.conversationId}::uuid
        AND message.normalized_subject = ${normalizedSubject}
        AND EXISTS (
          SELECT 1 FROM mail.message_placements placement
          WHERE placement.message_id = message.id AND placement.deleted_at IS NULL
        )
      GROUP BY conversation.id, conversation.latest_message_at
      ORDER BY conversation.latest_message_at DESC, conversation.id DESC
      LIMIT ${candidateLimitPerSignal}
    ), candidates AS MATERIALIZED (
      SELECT conversation_id FROM participant_candidates
      UNION
      SELECT conversation_id FROM subject_candidates
    ), signals AS MATERIALIZED (
      SELECT DISTINCT
        candidate.conversation_id,
        'participant'::text AS kind,
        address.normalized_email AS value,
        2::integer AS weight
      FROM candidates candidate
      JOIN mail.conversation_messages link ON link.conversation_id = candidate.conversation_id
      JOIN mail.message_addresses address ON address.message_id = link.message_id
      JOIN mail.message_contents message ON message.id = address.message_id
      WHERE ${participantEmails.length > 0}
        AND address.normalized_email = ANY(${toPgTextArray(participantEmails)}::text[])
        AND message.mailbox_id = ${params.mailboxId}::uuid
        AND EXISTS (
          SELECT 1 FROM mail.message_placements placement
          WHERE placement.message_id = message.id AND placement.deleted_at IS NULL
        )

      UNION

      SELECT DISTINCT
        candidate.conversation_id,
        'subject'::text AS kind,
        ${conversation.subject.trim().slice(0, 500) || "(No subject)"}::text AS value,
        1::integer AS weight
      FROM candidates candidate
      JOIN mail.conversation_messages link ON link.conversation_id = candidate.conversation_id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE ${normalizedSubject.length > 0}
        AND message.mailbox_id = ${params.mailboxId}::uuid
        AND message.normalized_subject = ${normalizedSubject}
        AND EXISTS (
          SELECT 1 FROM mail.message_placements placement
          WHERE placement.message_id = message.id AND placement.deleted_at IS NULL
        )
    ), ranked AS (
      SELECT signal.conversation_id, SUM(signal.weight)::integer AS score
      FROM signals signal
      WHERE signal.conversation_id <> ${params.conversationId}::uuid
      GROUP BY signal.conversation_id
    )
    SELECT
      conversation.id,
      conversation.subject,
      conversation.participant_summary,
      conversation.latest_message_at,
      latest.preview,
      reasons.items AS reasons
    FROM ranked
    JOIN mail.conversations conversation ON conversation.id = ranked.conversation_id
    JOIN LATERAL (
      SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT('kind', reason.kind, 'value', reason.value)
        ORDER BY reason.weight DESC, reason.kind, reason.value
      ) AS items
      FROM (
        SELECT signal.kind, signal.value, signal.weight
        FROM signals signal
        WHERE signal.conversation_id = conversation.id
        ORDER BY signal.weight DESC, signal.kind, signal.value
        LIMIT 6
      ) reason
    ) reasons ON true
    LEFT JOIN LATERAL (
      SELECT NULLIF(LEFT(BTRIM(COALESCE(message.plain_text, '')), 240), '') AS preview
      FROM mail.conversation_messages link
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE link.conversation_id = conversation.id
      ORDER BY message.internal_date DESC, message.id DESC
      LIMIT 1
    ) latest ON true
    WHERE conversation.mailbox_id = ${params.mailboxId}::uuid
    ORDER BY ranked.score DESC, conversation.latest_message_at DESC, conversation.id DESC
    LIMIT ${limit}
  `;

  return ok(
    rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      participantSummary: row.participant_summary,
      latestMessageAt: row.latest_message_at.toISOString(),
      preview: row.preview,
      reasons: z.array(relatedConversationReasonSchema).min(1).max(6).parse(row.reasons),
    })),
  );
};
