import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { convert } from "html-to-text";
import { z } from "zod";
import type { ConversationView, ConversationWorkStatus } from "../contracts";
import type { MailSecurityAssessment } from "../security-contracts";
import { type MailRequestContext, userBackedActor } from "./auth";
import { type ConversationCursorScope, decodeConversationCursor, encodeConversationCursor } from "./conversation-cursor";
import { resolveMailExecution } from "./execution";
import { mailingListMetadata } from "./mailing-list-metadata";
import { parseMessageProtocolFacts } from "./message-protocol";
import { OUTBOX_MAX_ATTEMPTS } from "./outbound-delivery";
import { type MessageRemoteContent, resolveMessagesRemoteContent } from "./remote-content";
import { assessMessages } from "./security";

type DateCursor = { version: 1; date: string; id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const encodeCursor = (cursor: DateCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string | undefined): Result<DateCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DateCursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.date !== "string" ||
      !Number.isFinite(Date.parse(parsed.date)) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return fail(err.badInput("Invalid pagination cursor"));
    }
    return ok(parsed as DateCursor);
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};

const parseJsonArray = <T>(value: T[] | string): T[] => (typeof value === "string" ? (JSON.parse(value) as T[]) : value);
const parseDeliveryRecipients = (value: Record<string, unknown> | string | null): { accepted: string[]; rejected: string[] } => {
  if (!value) return { accepted: [], rejected: [] };
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;
    const addresses = (key: "accepted" | "rejected") =>
      Array.isArray(parsed[key]) ? parsed[key].filter((address): address is string => typeof address === "string") : [];
    return { accepted: addresses("accepted"), rejected: addresses("rejected") };
  } catch {
    return { accepted: [], rejected: [] };
  }
};
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export type MailFolderView = {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  providerRole: string;
  configuredRole: string | null;
  selectable: boolean;
  showInSidebar: boolean;
  namespaceKinds: Array<"personal" | "other_users" | "shared">;
  discoveryState: "active" | "missing" | "ambiguous";
  missingSince: string | null;
  syncStatus: string;
  total: number;
  unread: number;
};

export const listFolders = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailFolderView[]>> => {
  const access = await resolveMailExecution({ mailboxId, operation: "actorRead", context });
  if (!access.ok) return access;
  const rows = await sql<
    {
      id: string;
      parent_id: string | null;
      name: string;
      role: string;
      provider_role: string;
      configured_role: string | null;
      selectable: boolean;
      show_in_sidebar: boolean;
      namespace_kinds: MailFolderView["namespaceKinds"];
      discovery_state: MailFolderView["discoveryState"];
      missing_since: Date | string | null;
      sync_status: string;
      total: number;
      unread: number;
    }[]
  >`
    SELECT
      f.id,
      f.parent_id,
      f.name,
      COALESCE(role_override.role, f.role) AS role,
      f.role AS provider_role,
      role_override.role AS configured_role,
      f.selectable,
      f.show_in_sidebar,
      ARRAY(
        SELECT DISTINCT ref.namespace_kind
        FROM mail.binding_folder_refs ref
        WHERE ref.folder_id = f.id AND ref.missing_since IS NULL AND ref.namespace_kind IS NOT NULL
        ORDER BY ref.namespace_kind
      ) AS namespace_kinds,
      f.discovery_state,
      f.missing_since,
      f.sync_status,
      COALESCE(placement_counts.total, 0)::int AS total,
      COALESCE(unread_counts.unread, 0)::int AS unread
    FROM mail.folders f
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    LEFT JOIN mail.folder_role_overrides role_override
      ON role_override.mailbox_id = rr.mailbox_id
     AND role_override.folder_id = f.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total
      FROM mail.message_placements placement
      WHERE placement.folder_id = f.id
        AND placement.deleted_at IS NULL
    ) placement_counts ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS unread
      FROM mail.message_placements placement
      WHERE placement.folder_id = f.id
        AND placement.deleted_at IS NULL
        AND NOT ('\\Seen' = ANY(placement.flags))
    ) unread_counts ON true
    WHERE rr.mailbox_id = ${mailboxId}::uuid
      AND NOT (f.discovery_state = 'missing' AND f.dismissed_at IS NOT NULL)
    ORDER BY
      CASE f.role
        WHEN 'inbox' THEN 0
        WHEN 'drafts' THEN 1
        WHEN 'sent' THEN 2
        WHEN 'archive' THEN 3
        WHEN 'trash' THEN 4
        WHEN 'junk' THEN 5
        ELSE 6
      END,
      f.name,
      f.id
  `;
  return ok(
    rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      role: row.role,
      providerRole: row.provider_role,
      configuredRole: row.configured_role,
      selectable: row.selectable,
      showInSidebar: row.show_in_sidebar,
      namespaceKinds: row.namespace_kinds,
      discoveryState: row.discovery_state,
      missingSince: row.missing_since ? toIso(row.missing_since) : null,
      syncStatus: row.sync_status,
      total: row.total,
      unread: row.unread,
    })),
  );
};

export type ConversationSummary = {
  id: string;
  primaryReference: string | null;
  subject: string;
  participantSummary: string;
  participantLabels: string[];
  latestMessageAt: string;
  workStatus: "needs_action" | "waiting" | "done";
  assigneeUserId: string | null;
  snoozedUntil: string | null;
  revision: number;
  updatedAt: string;
  unread: boolean;
  activeFolderIds: string[];
  flagged: boolean;
  hasAttachments: boolean;
  messageCount: number;
  preview: string | null;
  folderId: string | null;
  unreadFolderIds: string[];
};

type DbConversation = {
  id: string;
  primary_reference: string | null;
  subject: string;
  participant_summary: string;
  participant_labels: unknown;
  latest_message_at: Date | string;
  work_status: ConversationSummary["workStatus"];
  assignee_user_id: string | null;
  snoozed_until: Date | string | null;
  revision: string | number;
  updated_at: Date | string;
  sort_date: Date | string;
  unread: boolean;
  active_folder_ids: string[];
  flagged: boolean;
  has_attachments: boolean;
  message_count: number;
  preview: string | null;
  folder_id: string | null;
  unread_folder_ids: unknown;
};

const unreadFolderIdsSchema = z.array(z.uuid());
const participantLabelsSchema = z.array(z.string().trim().min(1));

export const listConversations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  folderId?: string | null;
  excludedFolderIds?: readonly string[];
  status?: ConversationWorkStatus | null;
  view?: ConversationView | null;
  unread?: boolean | null;
  cursor?: string;
  limit?: number;
}): Promise<Result<{ items: ConversationSummary[]; nextCursor: string | null }>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  const currentUserId = userBackedActor(params.context)?.id ?? null;
  const view = params.view ?? null;
  const folderId = params.folderId ?? null;
  const excludedFolderIds = [...new Set(params.excludedFolderIds ?? [])].sort();
  const includedPlacement = (folderId: Bun.SQL.Query<unknown>) => sql`
    NOT (${folderId} IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${excludedFolderIds}::jsonb)
    ))
  `;
  const cursorScope: ConversationCursorScope = {
    mailboxId: params.mailboxId,
    folderId,
    excludedFolderIds,
    status: params.status ?? null,
    view,
    unread: params.unread ?? null,
    userId: currentUserId,
  };
  const cursor = decodeConversationCursor(params.cursor, cursorScope);
  if (!cursor.ok) return cursor;
  const rows = await sql<DbConversation[]>`
    SELECT
      c.id,
      primary_reference.value AS primary_reference,
      c.subject,
      c.participant_summary,
      participant_state.labels AS participant_labels,
      c.latest_message_at,
      c.work_status,
      c.assignee_user_id,
      c.snoozed_until,
      c.revision,
      c.updated_at,
      CASE WHEN ${view}::text = 'recently_active' THEN c.updated_at ELSE c.latest_message_at END AS sort_date,
      cardinality(unread_state.folder_ids) > 0 AS unread,
      unread_state.folder_ids AS unread_folder_ids,
      active_state.folder_ids AS active_folder_ids,
      EXISTS (
        SELECT 1
        FROM mail.conversation_messages flagged_cm
        JOIN mail.message_placements flagged_mp ON flagged_mp.message_id = flagged_cm.message_id
        WHERE flagged_cm.conversation_id = c.id
          AND flagged_mp.deleted_at IS NULL
          AND ${includedPlacement(sql`flagged_mp.folder_id`)}
          AND '\\Flagged' = ANY(flagged_mp.flags)
          AND (${folderId}::uuid IS NULL OR flagged_mp.folder_id = ${folderId}::uuid)
      ) AS flagged,
      EXISTS (
        SELECT 1
        FROM mail.conversation_messages attachment_cm
        JOIN mail.attachments attachment ON attachment.message_id = attachment_cm.message_id
        WHERE attachment_cm.conversation_id = c.id
      ) AS has_attachments,
      (
        SELECT COUNT(*)::int FROM mail.conversation_messages count_cm WHERE count_cm.conversation_id = c.id
      ) AS message_count,
      latest.preview,
      latest.folder_id
    FROM mail.conversations c
    LEFT JOIN LATERAL (
      SELECT reference.value
      FROM mail.conversation_references reference
      WHERE reference.conversation_id = c.id AND reference.role = 'primary'
      ORDER BY reference.allocated_at, reference.id
      LIMIT 1
    ) primary_reference ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY(
        SELECT DISTINCT unread_mp.folder_id::text
        FROM mail.conversation_messages unread_cm
        JOIN mail.message_placements unread_mp ON unread_mp.message_id = unread_cm.message_id
        WHERE unread_cm.conversation_id = c.id
          AND unread_mp.deleted_at IS NULL
          AND ${includedPlacement(sql`unread_mp.folder_id`)}
          AND NOT ('\\Seen' = ANY(unread_mp.flags))
          AND (${folderId}::uuid IS NULL OR unread_mp.folder_id = ${folderId}::uuid)
        ORDER BY unread_mp.folder_id::text
      ) AS folder_ids
    ) unread_state ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY(
        SELECT DISTINCT active_mp.folder_id::text
        FROM mail.conversation_messages active_cm
        JOIN mail.message_placements active_mp ON active_mp.message_id = active_cm.message_id
        WHERE active_cm.conversation_id = c.id
          AND active_mp.deleted_at IS NULL
          AND ${includedPlacement(sql`active_mp.folder_id`)}
          AND (${folderId}::uuid IS NULL OR active_mp.folder_id = ${folderId}::uuid)
        ORDER BY active_mp.folder_id::text
      ) AS folder_ids
    ) active_state ON true
    LEFT JOIN LATERAL (
      SELECT
        mc.id AS message_id,
        LEFT(COALESCE(mc.plain_text, ''), 320) AS preview,
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = c.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = mc.id AND sender.role = 'from'
        ) AS outbound,
        (
          SELECT placement.folder_id
          FROM mail.message_placements placement
          WHERE placement.message_id = mc.id AND placement.deleted_at IS NULL
            AND ${includedPlacement(sql`placement.folder_id`)}
          ORDER BY placement.updated_at DESC, placement.folder_id DESC
          LIMIT 1
        ) AS folder_id
      FROM mail.conversation_messages cm
      JOIN mail.message_contents mc ON mc.id = cm.message_id
      WHERE cm.conversation_id = c.id
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY(
        SELECT participant.label
        FROM (
          SELECT DISTINCT ON (address.normalized_email)
            address.normalized_email,
            COALESCE(NULLIF(address.display_name, ''), address.email) AS label,
            CASE address.role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 WHEN 'bcc' THEN 2 ELSE 3 END AS role_order,
            address.position
          FROM mail.message_addresses address
          WHERE address.message_id = latest.message_id
            AND (
              (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
              OR (NOT latest.outbound AND address.role = 'from')
            )
          ORDER BY address.normalized_email, role_order, address.position
        ) participant
        ORDER BY participant.role_order, participant.position, participant.normalized_email
      ) AS labels
    ) participant_state ON true
    WHERE c.mailbox_id = ${params.mailboxId}::uuid
      AND (${params.status ?? null}::text IS NULL OR c.work_status = ${params.status ?? null})
      AND (
        ${view}::text IS NULL
        OR (${view} = 'needs_action' AND c.work_status = 'needs_action' AND (c.snoozed_until IS NULL OR c.snoozed_until <= now()))
        OR (
          ${view} = 'mine'
          AND c.assignee_user_id = ${currentUserId}::uuid
          AND c.work_status <> 'done'
          AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
        )
        OR (
          ${view} = 'unassigned'
          AND c.assignee_user_id IS NULL
          AND c.work_status <> 'done'
          AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
        )
        OR (${view} = 'waiting' AND c.work_status = 'waiting' AND (c.snoozed_until IS NULL OR c.snoozed_until <= now()))
        OR (${view} = 'done' AND c.work_status = 'done')
        OR (${view} = 'snoozed' AND c.snoozed_until > now())
        OR (
          ${view} = 'send_problems'
          AND EXISTS (
            SELECT 1
            FROM mail.conversation_messages problem_cm
            JOIN mail.outbox_submissions problem_outbox ON problem_outbox.message_id = problem_cm.message_id
            WHERE problem_cm.conversation_id = c.id
              AND (
                (problem_outbox.state = 'scheduled' AND problem_outbox.last_error_code IS NOT NULL)
                OR problem_outbox.state IN ('failed', 'unknown', 'reconciled_unsent', 'needs_attention')
              )
          )
        )
        OR ${view} = 'recently_active'
      )
      AND (
        ${folderId}::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM mail.conversation_messages folder_cm
          JOIN mail.message_placements folder_mp ON folder_mp.message_id = folder_cm.message_id
          WHERE folder_cm.conversation_id = c.id
            AND folder_mp.folder_id = ${folderId}::uuid
            AND folder_mp.deleted_at IS NULL
        )
      )
      AND (
        ${params.unread ?? null}::boolean IS NULL
        OR (cardinality(unread_state.folder_ids) > 0) = ${params.unread ?? null}
      )
      AND EXISTS (
        SELECT 1
        FROM mail.conversation_messages visible_cm
        LEFT JOIN mail.message_placements visible_mp
          ON visible_mp.message_id = visible_cm.message_id
         AND visible_mp.deleted_at IS NULL
         AND ${includedPlacement(sql`visible_mp.folder_id`)}
        LEFT JOIN mail.outbox_submissions visible_outbox
          ON visible_outbox.message_id = visible_cm.message_id
         AND visible_outbox.state <> 'cancelled'
        WHERE visible_cm.conversation_id = c.id
          AND (
            visible_mp.message_id IS NOT NULL
            OR (
              visible_outbox.id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM mail.message_placements any_visible_mp
                WHERE any_visible_mp.message_id = visible_cm.message_id
                  AND any_visible_mp.deleted_at IS NULL
              )
            )
          )
      )
      AND (
        ${cursor.data?.id ?? null}::uuid IS NULL
        OR (
          CASE WHEN ${view}::text = 'recently_active' THEN c.updated_at ELSE c.latest_message_at END,
          c.id
        ) < (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)
      )
    ORDER BY sort_date DESC, c.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => ({
    id: row.id,
    primaryReference: row.primary_reference,
    subject: row.subject,
    participantSummary: row.participant_summary,
    participantLabels: participantLabelsSchema.parse(row.participant_labels),
    latestMessageAt: toIso(row.latest_message_at),
    workStatus: row.work_status,
    assigneeUserId: row.assignee_user_id,
    snoozedUntil: row.snoozed_until ? toIso(row.snoozed_until) : null,
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at),
    unread: row.unread,
    activeFolderIds: row.active_folder_ids,
    flagged: row.flagged,
    hasAttachments: row.has_attachments,
    messageCount: row.message_count,
    preview: row.preview || null,
    folderId: row.folder_id,
    unreadFolderIds: unreadFolderIdsSchema.parse(row.unread_folder_ids),
  }));
  const last = items.at(-1);
  const lastRow = pageRows.at(-1);
  return ok({
    items,
    nextCursor:
      hasMore && last && lastRow ? encodeConversationCursor({ scope: cursorScope, date: toIso(lastRow.sort_date), id: last.id }) : null,
  });
};

export type ConversationViewCounts = Record<ConversationView, number>;

export const getConversationViewCounts = async (params: {
  context: MailRequestContext;
  mailboxId: string;
}): Promise<Result<ConversationViewCounts>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const currentUserId = userBackedActor(params.context)?.id ?? null;
  const [row] = await sql<
    {
      needs_action: number;
      mine: number;
      unassigned: number;
      waiting: number;
      done: number;
      snoozed: number;
      send_problems: number;
      recently_active: number;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (
        WHERE c.work_status = 'needs_action' AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
      )::int AS needs_action,
      COUNT(*) FILTER (
        WHERE c.assignee_user_id = ${currentUserId}::uuid
          AND c.work_status <> 'done'
          AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
      )::int AS mine,
      COUNT(*) FILTER (
        WHERE c.assignee_user_id IS NULL
          AND c.work_status <> 'done'
          AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
      )::int AS unassigned,
      COUNT(*) FILTER (
        WHERE c.work_status = 'waiting' AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
      )::int AS waiting,
      COUNT(*) FILTER (WHERE c.work_status = 'done')::int AS done,
      COUNT(*) FILTER (WHERE c.snoozed_until > now())::int AS snoozed,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM mail.conversation_messages problem_cm
          JOIN mail.outbox_submissions problem_outbox ON problem_outbox.message_id = problem_cm.message_id
          WHERE problem_cm.conversation_id = c.id
            AND (
              (problem_outbox.state = 'scheduled' AND problem_outbox.last_error_code IS NOT NULL)
              OR problem_outbox.state IN ('failed', 'unknown', 'reconciled_unsent', 'needs_attention')
            )
        )
      )::int AS send_problems,
      COUNT(*)::int AS recently_active
    FROM mail.conversations c
    WHERE c.mailbox_id = ${params.mailboxId}::uuid
      AND EXISTS (
        SELECT 1
        FROM mail.conversation_messages visible_cm
        LEFT JOIN mail.message_placements visible_mp
          ON visible_mp.message_id = visible_cm.message_id
         AND visible_mp.deleted_at IS NULL
        LEFT JOIN mail.outbox_submissions visible_outbox
          ON visible_outbox.message_id = visible_cm.message_id
         AND visible_outbox.state <> 'cancelled'
        WHERE visible_cm.conversation_id = c.id
          AND (visible_mp.message_id IS NOT NULL OR visible_outbox.id IS NOT NULL)
      )
  `;
  return ok({
    needs_action: row?.needs_action ?? 0,
    mine: row?.mine ?? 0,
    unassigned: row?.unassigned ?? 0,
    waiting: row?.waiting ?? 0,
    done: row?.done ?? 0,
    snoozed: row?.snoozed ?? 0,
    send_problems: row?.send_problems ?? 0,
    recently_active: row?.recently_active ?? 0,
  });
};

export type MessageSummary = {
  id: string;
  subject: string;
  preview: string | null;
  hasAttachments: boolean;
  messageId: string | null;
  internalDate: string;
  sentAt: string | null;
  from: Array<{ name: string | null; address: string }>;
  to: Array<{ name: string | null; address: string }>;
  flags: string[];
  keywords: string[];
  hydrationStatus: string;
  remoteAvailable: boolean;
  folderId: string | null;
};

type DbMessageSummary = {
  id: string;
  subject: string;
  preview: string | null;
  has_attachments: boolean;
  message_id: string | null;
  internal_date: Date | string;
  sent_at: Date | string | null;
  from_addresses: Array<{ name: string | null; address: string }> | string;
  to_addresses: Array<{ name: string | null; address: string }> | string;
  flags: string[] | null;
  keywords: string[] | null;
  hydration_status: string;
  remote_available: boolean;
  remote_message_ref_id: string | null;
  folder_id: string | null;
};

const mapMessageSummary = (row: DbMessageSummary): MessageSummary => ({
  id: row.id,
  subject: row.subject,
  preview: row.preview || null,
  hasAttachments: row.has_attachments,
  messageId: row.message_id,
  internalDate: toIso(row.internal_date),
  sentAt: row.sent_at ? toIso(row.sent_at) : null,
  from: parseJsonArray(row.from_addresses),
  to: parseJsonArray(row.to_addresses),
  flags: row.flags ?? [],
  keywords: row.keywords ?? [],
  hydrationStatus: row.hydration_status,
  remoteAvailable: row.remote_available,
  folderId: row.folder_id,
});

const messageSummarySelect = sql`
  mc.id,
  mc.subject,
  NULLIF(LEFT(COALESCE(mc.plain_text, ''), 240), '') AS preview,
  EXISTS (SELECT 1 FROM mail.attachments attachment WHERE attachment.message_id = mc.id) AS has_attachments,
  mc.message_id,
  mc.internal_date,
  mc.sent_at,
  COALESCE(from_rows.addresses, '[]'::jsonb) AS from_addresses,
  COALESCE(to_rows.addresses, '[]'::jsonb) AS to_addresses,
  COALESCE(placement.flags, ARRAY[]::text[]) AS flags,
  COALESCE(placement.keywords, ARRAY[]::text[]) AS keywords,
  mc.hydration_status,
  placement.remote_message_ref_id,
  placement.folder_id,
  EXISTS (
    SELECT 1 FROM mail.message_placements available
    WHERE available.message_id = mc.id AND available.deleted_at IS NULL
  ) AS remote_available
`;

const messageSummaryJoins = (preferredFolderId?: string | null) => sql`
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
    FROM mail.message_addresses ma
    WHERE ma.message_id = mc.id AND ma.role = 'from'
  ) from_rows ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
    FROM mail.message_addresses ma
    WHERE ma.message_id = mc.id AND ma.role = 'to'
  ) to_rows ON true
  LEFT JOIN LATERAL (
    SELECT mp.flags, mp.keywords, mp.remote_message_ref_id, mp.folder_id
    FROM mail.message_placements mp
    WHERE mp.message_id = mc.id AND mp.deleted_at IS NULL
    ORDER BY (mp.folder_id = ${preferredFolderId ?? null}::uuid) DESC, mp.updated_at DESC
    LIMIT 1
  ) placement ON true
`;

export const listConversationMessages = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
  latest?: boolean;
}): Promise<Result<{ items: MessageSummary[]; nextCursor: string | null }>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const cursor = decodeCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  const [conversation] = await sql<{ id: string }[]>`
    SELECT id FROM mail.conversations WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const rows = params.latest
    ? await sql<DbMessageSummary[]>`
        SELECT ${messageSummarySelect}
        FROM mail.conversation_messages cm
        JOIN mail.message_contents mc ON mc.id = cm.message_id
        ${messageSummaryJoins()}
        WHERE cm.conversation_id = ${params.conversationId}::uuid
          AND (${cursor.data?.id ?? null}::uuid IS NULL OR (mc.internal_date, mc.id) < (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
        ORDER BY mc.internal_date DESC, mc.id DESC
        LIMIT ${limit + 1}
      `
    : await sql<DbMessageSummary[]>`
        SELECT ${messageSummarySelect}
        FROM mail.conversation_messages cm
        JOIN mail.message_contents mc ON mc.id = cm.message_id
        ${messageSummaryJoins()}
        WHERE cm.conversation_id = ${params.conversationId}::uuid
          AND (${cursor.data?.id ?? null}::uuid IS NULL OR (mc.internal_date, mc.id) > (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
        ORDER BY mc.internal_date, mc.id
        LIMIT ${limit + 1}
      `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const cursorItem = pageRows.at(-1);
  const items = (params.latest ? pageRows.toReversed() : pageRows).map(mapMessageSummary);
  return ok({
    items,
    nextCursor: hasMore && cursorItem ? encodeCursor({ version: 1, date: toIso(cursorItem.internal_date), id: cursorItem.id }) : null,
  });
};

export type MessageDeliveryState =
  | "scheduled"
  | "undo_window"
  | "sending"
  | "accepted"
  | "sent_sync_pending"
  | "sent"
  | "failed"
  | "cancelled"
  | "unknown"
  | "reconciled_accepted"
  | "reconciled_unsent"
  | "needs_attention";

export type MessageDetail = MessageSummary & {
  contentType: string | null;
  sizeBytes: number;
  replyTo: Array<{ name: string | null; address: string }>;
  cc: Array<{ name: string | null; address: string }>;
  plainText: string | null;
  sanitizedHtml: string | null;
  forwardText: string;
  selectedHeaders: Record<string, unknown>;
  sourceAvailable: boolean;
  mailingList: ReturnType<typeof mailingListMetadata>;
  remoteContent: MessageRemoteContent;
  security?: MailSecurityAssessment;
  delivery: {
    submissionId: string;
    draftId: string;
    state: MessageDeliveryState;
    attempt: number;
    maxAttempts: number;
    scheduledAt: string;
    undoUntil: string | null;
    acceptedAt: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    acceptedRecipients: string[];
    rejectedRecipients: string[];
  } | null;
  attachments: Array<{
    id: string;
    filename: string | null;
    contentType: string;
    sizeBytes: number;
    contentId: string | null;
  }>;
};

type DbMessageDetail = DbMessageSummary & {
  content_type: string | null;
  size_bytes: string | number;
  reply_to_addresses: Array<{ name: string | null; address: string }> | string;
  cc_addresses: Array<{ name: string | null; address: string }> | string;
  plain_text: string | null;
  sanitized_html: string | null;
  selected_headers: Record<string, unknown> | string;
  protocol_facts: Record<string, unknown> | string;
  source_available: boolean;
  delivery_submission_id: string | null;
  delivery_draft_id: string | null;
  delivery_state: MessageDeliveryState | null;
  delivery_attempt: string | number | null;
  delivery_scheduled_at: Date | string | null;
  delivery_undo_until: Date | string | null;
  delivery_accepted_at: Date | string | null;
  delivery_error_code: string | null;
  delivery_error_message: string | null;
  delivery_provider_response: Record<string, unknown> | string | null;
  attachments: Array<{ id: string; filename: string | null; contentType: string; sizeBytes: number; contentId: string | null }> | string;
};

export const messageForwardText = (plainText: string | null, sanitizedHtml: string | null): string => {
  if (plainText?.trim()) return plainText;
  if (!sanitizedHtml) return "";
  try {
    return convert(sanitizedHtml, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
    }).trimEnd();
  } catch {
    return "";
  }
};

const mapMessageDetail = (row: DbMessageDetail): MessageDetail => ({
  ...mapMessageSummary(row),
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes),
  replyTo: parseJsonArray(row.reply_to_addresses),
  cc: parseJsonArray(row.cc_addresses),
  plainText: row.plain_text,
  sanitizedHtml: row.sanitized_html,
  forwardText: messageForwardText(row.plain_text, row.sanitized_html),
  selectedHeaders:
    typeof row.selected_headers === "string" ? (JSON.parse(row.selected_headers) as Record<string, unknown>) : row.selected_headers,
  sourceAvailable: row.source_available,
  mailingList: mailingListMetadata(parseMessageProtocolFacts(row.protocol_facts)),
  remoteContent: {
    imageIds: [],
    allowedByRule: false,
    sender: null,
    domain: null,
  },
  delivery:
    row.delivery_submission_id && row.delivery_draft_id
      ? (() => {
          const recipients = parseDeliveryRecipients(row.delivery_provider_response);
          return {
            submissionId: row.delivery_submission_id,
            draftId: row.delivery_draft_id,
            state: row.delivery_state!,
            attempt: Number(row.delivery_attempt ?? 0),
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            scheduledAt: toIso(row.delivery_scheduled_at!),
            undoUntil: row.delivery_undo_until ? toIso(row.delivery_undo_until) : null,
            acceptedAt: row.delivery_accepted_at ? toIso(row.delivery_accepted_at) : null,
            lastErrorCode: row.delivery_error_code,
            lastErrorMessage: row.delivery_error_message,
            acceptedRecipients: recipients.accepted,
            rejectedRecipients: recipients.rejected,
          };
        })()
      : null,
  attachments: parseJsonArray(row.attachments),
});

const attachRemoteContent = async (
  context: MailRequestContext,
  mailboxId: string,
  messages: MessageDetail[],
): Promise<Result<MessageDetail[]>> => {
  const metadata = await resolveMessagesRemoteContent({ context, mailboxId, messages });
  if (!metadata.ok) return metadata;
  return ok(
    messages.map((message) => ({
      ...message,
      remoteContent: metadata.data.get(message.id) ?? message.remoteContent,
    })),
  );
};

const attachSecurity = async (mailboxId: string, messages: MessageDetail[]): Promise<Result<MessageDetail[]>> => {
  const assessments = await assessMessages(
    mailboxId,
    messages.map((message) => message.id),
  );
  if (!assessments.ok) return assessments;
  return ok(
    messages.map((message) => ({
      ...message,
      security: assessments.data.get(message.id) ?? message.security,
    })),
  );
};

const attachMessageMetadata = async (
  context: MailRequestContext,
  mailboxId: string,
  messages: MessageDetail[],
): Promise<Result<MessageDetail[]>> => {
  const remote = await attachRemoteContent(context, mailboxId, messages);
  return remote.ok ? attachSecurity(mailboxId, remote.data) : remote;
};

const messageDetailSelect = sql`
  ${messageSummarySelect},
  NULLIF(mc.protocol_facts->>'contentType', '') AS content_type,
  mc.size_bytes,
  mc.plain_text,
  mc.sanitized_html,
  (
    mc.source_blob_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM mail.message_part_blobs source_blob
      WHERE source_blob.id = mc.source_blob_id
        AND source_blob.complete = true
    )
  ) AS source_available,
  COALESCE(reply_to_rows.addresses, '[]'::jsonb) AS reply_to_addresses,
  COALESCE(cc_rows.addresses, '[]'::jsonb) AS cc_addresses,
  mc.selected_headers,
  mc.protocol_facts,
  delivery.id AS delivery_submission_id,
  delivery.draft_id AS delivery_draft_id,
  delivery.state AS delivery_state,
  delivery.attempt AS delivery_attempt,
  delivery.scheduled_at AS delivery_scheduled_at,
  delivery.undo_until AS delivery_undo_until,
  delivery.accepted_at AS delivery_accepted_at,
  delivery.last_error_code AS delivery_error_code,
  delivery.last_error_message AS delivery_error_message,
  delivery.provider_response AS delivery_provider_response,
  COALESCE(attachment_rows.items, '[]'::jsonb) AS attachments
`;

const messageDetailAddressJoin = sql`
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
    FROM mail.message_addresses ma
    WHERE ma.message_id = mc.id AND ma.role = 'reply_to'
  ) reply_to_rows ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
    FROM mail.message_addresses ma
    WHERE ma.message_id = mc.id AND ma.role = 'cc'
  ) cc_rows ON true
`;

const messageDetailAttachmentJoin = sql`
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'filename', a.filename,
        'contentType', a.content_type,
        'sizeBytes', a.size_bytes,
        'contentId', a.content_id
      ) ORDER BY a.id
    ) AS items
    FROM mail.attachments a
    WHERE a.message_id = mc.id
  ) attachment_rows ON true
`;

const messageDetailDeliveryJoin = sql`
  LEFT JOIN mail.outbox_submissions delivery ON delivery.message_id = mc.id
`;

export const listConversationMessageDetails = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  preferredFolderId?: string | null;
  limit?: number;
}): Promise<Result<MessageDetail[]>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  const rows = await sql<DbMessageDetail[]>`
    WITH selected_messages AS (
      SELECT conversation_message.message_id
      FROM mail.conversation_messages conversation_message
      JOIN mail.message_contents content ON content.id = conversation_message.message_id
      WHERE conversation_message.conversation_id = ${params.conversationId}::uuid
        AND content.mailbox_id = ${params.mailboxId}::uuid
      ORDER BY content.internal_date DESC, content.id DESC
      LIMIT ${limit}
    )
    SELECT ${messageDetailSelect}
    FROM selected_messages selected_message
    JOIN mail.message_contents mc ON mc.id = selected_message.message_id
    ${messageSummaryJoins(params.preferredFolderId)}
    ${messageDetailAddressJoin}
    ${messageDetailAttachmentJoin}
    ${messageDetailDeliveryJoin}
    ORDER BY mc.internal_date, mc.id
  `;
  return attachMessageMetadata(params.context, params.mailboxId, rows.map(mapMessageDetail));
};

export const getMessage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MessageDetail>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const [row] = await sql<DbMessageDetail[]>`
    SELECT ${messageDetailSelect}
    FROM mail.message_contents mc
    ${messageSummaryJoins()}
    ${messageDetailAddressJoin}
    ${messageDetailAttachmentJoin}
    ${messageDetailDeliveryJoin}
    WHERE mc.id = ${params.messageId}::uuid AND mc.mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!row) return fail(err.notFound("Message"));
  const resolved = await attachMessageMetadata(params.context, params.mailboxId, [mapMessageDetail(row)]);
  return resolved.ok ? ok(resolved.data[0]!) : resolved;
};

export type AttachmentDownload = {
  blobId: string;
  total: number;
  chunkSize: number;
  chunkCount: number;
  contentHash: string;
  contentType: string;
  filename: string | null;
};

export const openAttachment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  attachmentId: string;
}): Promise<Result<AttachmentDownload>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const { messageId, attachmentId } = params;
  const [attachment] = await sql<
    {
      blob_id: string;
      content_type: string;
      filename: string | null;
      content_hash: string;
      byte_length: string | number;
      chunk_size: number;
      chunk_count: number;
    }[]
  >`
    SELECT
      a.blob_id,
      a.content_type,
      a.filename,
      blob.content_hash,
      blob.byte_length,
      blob.chunk_size,
      blob.chunk_count
    FROM mail.attachments a
    JOIN mail.message_contents mc ON mc.id = a.message_id
    JOIN mail.message_part_blobs blob ON blob.id = a.blob_id AND blob.complete = true
    WHERE a.id = ${attachmentId}::uuid
      AND a.message_id = ${messageId}::uuid
      AND mc.mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!attachment) return fail(err.notFound("Attachment"));
  const total = Number(attachment.byte_length);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(attachment.chunk_size) ||
    attachment.chunk_size <= 0 ||
    !Number.isSafeInteger(attachment.chunk_count) ||
    attachment.chunk_count < 0 ||
    (total === 0 ? attachment.chunk_count !== 0 : attachment.chunk_count === 0)
  ) {
    return fail(err.internal("Attachment metadata is invalid"));
  }
  return ok({
    blobId: attachment.blob_id,
    total,
    chunkSize: attachment.chunk_size,
    chunkCount: attachment.chunk_count,
    contentHash: attachment.content_hash,
    contentType: attachment.content_type,
    filename: attachment.filename,
  });
};

export const createAttachmentStream = (params: {
  blobId: string;
  chunkSize: number;
  chunkCount: number;
  start: number;
  endExclusive: number;
  assertCurrentAccess?: () => Promise<void>;
}): ReadableStream<Uint8Array> => {
  const firstPosition = Math.floor(params.start / params.chunkSize);
  const lastPosition = params.endExclusive > params.start ? Math.floor((params.endExclusive - 1) / params.chunkSize) : firstPosition - 1;
  let nextPosition = firstPosition;
  let buffered: Array<{ position: number; bytes: Uint8Array }> = [];
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      if (nextPosition > lastPosition) {
        controller.close();
        return;
      }
      await params.assertCurrentAccess?.();
      if (buffered.length === 0) {
        const batchEnd = Math.min(lastPosition, nextPosition + 7);
        buffered = await sql<{ position: number; bytes: Uint8Array }[]>`
          SELECT position, bytes
          FROM mail.message_part_chunks
          WHERE blob_id = ${params.blobId}::uuid
            AND position BETWEEN ${nextPosition} AND ${batchEnd}
          ORDER BY position
        `;
      }
      const chunk = buffered.shift();
      if (!chunk || chunk.position !== nextPosition || chunk.position >= params.chunkCount) {
        controller.error(new Error("Attachment blob is incomplete"));
        return;
      }
      const chunkStart = chunk.position * params.chunkSize;
      const startInChunk = Math.max(0, params.start - chunkStart);
      const endInChunk = Math.min(chunk.bytes.byteLength, params.endExclusive - chunkStart);
      const bytes = chunk.bytes.subarray(startInChunk, endInChunk);
      nextPosition += 1;
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
      buffered = [];
    },
  });
};

export const readAttachmentPrefix = async (blobId: string, byteLength = 16): Promise<Uint8Array> => {
  const [row] = await sql<{ bytes: Uint8Array }[]>`
    SELECT substring(bytes FROM 1 FOR ${Math.min(Math.max(Math.floor(byteLength), 1), 64)}) AS bytes
    FROM mail.message_part_chunks
    WHERE blob_id = ${blobId}::uuid AND position = 0
  `;
  return row?.bytes ?? new Uint8Array();
};
