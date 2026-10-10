import { toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { MailFocusView } from "../contracts";
import { conversationVisibleTo, isCurrentActorActive, readableMailboxGrants } from "./access";
import { capByCredentialScopes, type MailRequestContext, userBackedActor } from "./auth";
import { isUnassignedConversation, listLapsedAssignees } from "./collaborators";
import { isUnsentOutboundMessage } from "./conversation-timeline";
import { type AggregatedViewScope, loadAggregatedViewScope, staysInAggregatedViews } from "./folder-display";
import { isFollowUpConversation, isTrashOrJunkFolder } from "./follow-up-scope";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FocusCursor = { version: 1; view: MailFocusView; userId: string | null; date: string; id: string };

export type MailFocusItem = {
  id: string;
  mailboxId: string;
  mailboxName: string;
  subject: string;
  participantSummary: string;
  latestMessageAt: string;
  workStatus: "needs_action" | "waiting" | "done";
  assigneeUserIds: string[];
  revision: number;
  sourceFolderId: string | null;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  preview: string | null;
};

export type MailFocusCounts = Record<MailFocusView, number>;

export type MailFocusMailboxCounts = {
  mailboxId: string;
  unread: number;
  needsAction: number;
};

type DbFocusItem = {
  id: string;
  mailbox_id: string;
  mailbox_name: string;
  subject: string;
  participant_summary: string;
  latest_message_at: Date | string;
  cursor_at: string;
  work_status: MailFocusItem["workStatus"];
  assignee_user_ids: string[];
  revision: number;
  source_folder_id: string | null;
  unread: boolean;
  flagged: boolean;
  has_attachments: boolean;
  preview: string | null;
};

type DbMailboxCounts = {
  mailbox_id: string;
  unread: number;
  needs_action: number;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const encodeCursor = (cursor: FocusCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string | undefined, view: MailFocusView, userId: string | null): Result<FocusCursor | null> => {
  if (!value) return ok(null);
  if (value.length > 2_000) return fail(err.badInput("Invalid pagination cursor"));
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FocusCursor>;
    if (
      parsed.version !== 1 ||
      parsed.view !== view ||
      parsed.userId !== userId ||
      typeof parsed.date !== "string" ||
      !Number.isFinite(Date.parse(parsed.date)) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return fail(err.badInput("Invalid pagination cursor"));
    }
    return ok(parsed as FocusCursor);
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};

const boundMailboxId = (context: MailRequestContext): string | null => {
  if (context.actor.kind !== "service_account" || context.actor.serviceAccount.kind !== "resource_bound") return null;
  if (context.actor.serviceAccount.appId !== "mail" || context.actor.serviceAccount.resourceType !== "mailbox")
    return "00000000-0000-0000-0000-000000000000";
  return context.actor.serviceAccount.resourceId;
};

/** Mailboxes the request may read, as a subquery of `mailbox_id` rows. */
export const readableMailboxes = (context: MailRequestContext) => sql<{ mailbox_id: string; scope: "mailbox" | "assigned" }[]>`
  SELECT grants.mailbox_id, grants.scope
  FROM (${readableMailboxGrants(context)}) grants
  WHERE (${boundMailboxId(context)}::uuid IS NULL OR grants.mailbox_id = ${boundMailboxId(context)}::uuid)
`;
/**
 * Every focus list and count covers open conversations only, so each readable conversation
 * carries whether it belongs in the follow-up views; Done ones skip that check. It also carries
 * whether it belongs in views that mix folders, which leave out mail kept inside its folder.
 */
const readableConversations = (context: MailRequestContext, scope: AggregatedViewScope) => sql`
  SELECT
    c.*,
    CASE WHEN c.work_status <> 'done' THEN ${isFollowUpConversation(sql`c.id`)} ELSE false END AS follow_up,
    ${staysInAggregatedViews(sql`c.id`, scope)} AS aggregated
  FROM mail.conversations c
  JOIN (${readableMailboxes(context)}) readable ON readable.mailbox_id = c.mailbox_id
  WHERE (readable.scope = 'mailbox' OR ${conversationVisibleTo(
    context.accessSubject.type === "user"
      ? { scope: "assigned", permission: "read", userId: context.accessSubject.userId }
      : { scope: "mailbox", permission: "read" },
    sql`c.id`,
  )})
    AND EXISTS (
      SELECT 1
      FROM mail.conversation_messages visible_cm
      LEFT JOIN mail.message_placements visible_mp
        ON visible_mp.message_id = visible_cm.message_id AND visible_mp.deleted_at IS NULL
      LEFT JOIN mail.outbox_submissions visible_outbox
        ON visible_outbox.message_id = visible_cm.message_id AND visible_outbox.state <> 'cancelled'
      WHERE visible_cm.conversation_id = c.id
        AND (visible_mp.message_id IS NOT NULL OR visible_outbox.id IS NOT NULL)
    )
`;

const visibleNow = sql`(c.snoozed_until IS NULL OR c.snoozed_until <= now())`;

/**
 * A mailbox counts unread mail outside Trash and Junk, like All mail, and the conversations that need
 * action; both leave out conversations whose mail is kept inside its folders. Rows come in mailbox ID
 * order, so every caller sees the same list.
 */
const mailboxCountQuery = (context: MailRequestContext, scope: AggregatedViewScope) => sql<DbMailboxCounts[]>`
  WITH readable_conversations AS (${readableConversations(context, scope)})
  SELECT c.mailbox_id,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM mail.conversation_messages cm
      JOIN mail.message_placements mp ON mp.message_id = cm.message_id
      WHERE cm.conversation_id = c.id AND mp.deleted_at IS NULL
        AND NOT ('\\Seen' = ANY(mp.flags))
        AND NOT ${isTrashOrJunkFolder(sql`mp.folder_id`)}
    ))::int AS unread,
    COUNT(*) FILTER (WHERE c.work_status = 'needs_action' AND ${visibleNow} AND c.follow_up)::int AS needs_action
  FROM readable_conversations c
  WHERE c.aggregated
  GROUP BY c.mailbox_id
  ORDER BY c.mailbox_id
`;

/** The scope of every mailbox the request may read. */
const readableAggregatedViewScope = async (context: MailRequestContext): Promise<AggregatedViewScope> =>
  loadAggregatedViewScope((await readableMailboxes(context)).map((row) => row.mailbox_id));

export const listMailboxCounts = async (context: MailRequestContext): Promise<Result<MailFocusMailboxCounts[]>> => {
  if (!(await isCurrentActorActive(context)) || capByCredentialScopes(context, "read") === "none") {
    return fail(err.forbidden("Access denied"));
  }
  const rows = await mailboxCountQuery(context, await readableAggregatedViewScope(context));
  return ok(rows.map((row) => ({ mailboxId: row.mailbox_id, unread: row.unread, needsAction: row.needs_action })));
};

export const listFocusConversations = async (params: {
  context: MailRequestContext;
  view?: MailFocusView;
  cursor?: string;
  limit?: number;
  /**
   * Mailboxes the person hid from their overview. Their conversations leave the list and the
   * view counts; `mailboxCounts` still covers them so a revealed hidden mailbox keeps its counts.
   */
  excludedMailboxIds?: string[];
}): Promise<
  Result<{ items: MailFocusItem[]; counts: MailFocusCounts; mailboxCounts: MailFocusMailboxCounts[]; nextCursor: string | null }>
> => {
  if (!(await isCurrentActorActive(params.context))) return fail(err.forbidden("Access denied"));
  if (capByCredentialScopes(params.context, "read") === "none") return fail(err.forbidden("Access denied"));

  const view = params.view ?? "mine";
  const userId = userBackedActor(params.context)?.id ?? null;
  if ((view === "mine" || view === "waiting") && !userId) {
    return fail(err.badInput(`The ${view} view requires a user-backed actor`));
  }
  const cursor = decodeCursor(params.cursor, view, userId);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  const readableMailboxIds = (await readableMailboxes(params.context)).map((row) => row.mailbox_id);
  const [lapsedAssignees, scope] = await Promise.all([
    listLapsedAssignees({ mailboxIds: readableMailboxIds }),
    loadAggregatedViewScope(readableMailboxIds),
  ]);
  const unassigned = isUnassignedConversation(lapsedAssignees);
  const shown = sql`NOT (c.mailbox_id = ANY(${toPgUuidArray(params.excludedMailboxIds)}::uuid[]))`;

  const [rows, countRows, mailboxCountRows] = await Promise.all([
    sql<DbFocusItem[]>`
      WITH readable_conversations AS (${readableConversations(params.context, scope)})
      SELECT
        c.id,
        c.mailbox_id,
        mailbox.name AS mailbox_name,
        c.subject,
        c.participant_summary,
        c.latest_message_at,
        to_char(c.latest_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
        c.work_status,
        COALESCE((SELECT array_agg(a.user_id::text ORDER BY a.assigned_at, a.user_id) FROM mail.conversation_assignees a WHERE a.conversation_id = c.id), ARRAY[]::text[]) AS assignee_user_ids,
        c.revision,
        (SELECT CASE WHEN count(DISTINCT mp.folder_id) = 1 THEN min(mp.folder_id::text) ELSE NULL END
          FROM mail.conversation_messages cm
          JOIN mail.message_placements mp ON mp.message_id = cm.message_id AND mp.deleted_at IS NULL
          WHERE cm.conversation_id = c.id) AS source_folder_id,
        EXISTS (
          SELECT 1
          FROM mail.conversation_messages unread_cm
          JOIN mail.message_placements unread_mp ON unread_mp.message_id = unread_cm.message_id
          WHERE unread_cm.conversation_id = c.id
            AND unread_mp.deleted_at IS NULL
            AND NOT ('\\Seen' = ANY(unread_mp.flags))
        ) AS unread,
        EXISTS (
          SELECT 1
          FROM mail.conversation_messages flagged_cm
          JOIN mail.message_placements flagged_mp ON flagged_mp.message_id = flagged_cm.message_id
          WHERE flagged_cm.conversation_id = c.id
            AND flagged_mp.deleted_at IS NULL
            AND '\\Flagged' = ANY(flagged_mp.flags)
        ) AS flagged,
        EXISTS (
          SELECT 1 FROM mail.conversation_messages attachment_cm
          JOIN mail.attachments attachment ON attachment.message_id = attachment_cm.message_id
          WHERE attachment_cm.conversation_id = c.id
        ) AS has_attachments,
        latest.preview
      FROM readable_conversations c
      JOIN mail.mailboxes mailbox ON mailbox.id = c.mailbox_id
      LEFT JOIN LATERAL (
        SELECT LEFT(COALESCE(content.plain_text, ''), 320) AS preview
        FROM mail.conversation_messages cm
        JOIN mail.message_contents content ON content.id = cm.message_id
        WHERE cm.conversation_id = c.id
          AND NOT ${isUnsentOutboundMessage(sql`content.id`)}
        ORDER BY content.internal_date DESC, content.id DESC
        LIMIT 1
      ) latest ON true
      WHERE c.follow_up
        AND ${shown}
        AND (
          (${view} = 'mine' AND EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = c.id AND a.user_id = ${userId}::uuid) AND c.work_status = 'needs_action' AND ${visibleNow})
          OR (${view} = 'unassigned' AND c.aggregated AND ${unassigned} AND c.work_status = 'needs_action' AND ${visibleNow})
          OR (${view} = 'waiting' AND EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = c.id AND a.user_id = ${userId}::uuid) AND c.work_status = 'waiting' AND ${visibleNow})
          OR (${view} = 'all' AND c.aggregated AND c.work_status <> 'done' AND ${visibleNow})
        )
        AND (
          ${cursor.data?.id ?? null}::uuid IS NULL
          OR (c.latest_message_at, c.id) < (${cursor.data?.date ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)
        )
      ORDER BY c.latest_message_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `,
    sql<Array<{ mine: number; unassigned: number; waiting: number; all: number }>>`
      WITH readable_conversations AS (${readableConversations(params.context, scope)})
      SELECT
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = c.id AND a.user_id = ${userId}::uuid) AND c.work_status = 'needs_action' AND ${visibleNow})::int AS mine,
        COUNT(*) FILTER (WHERE c.aggregated AND ${unassigned} AND c.work_status = 'needs_action' AND ${visibleNow})::int AS unassigned,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = c.id AND a.user_id = ${userId}::uuid) AND c.work_status = 'waiting' AND ${visibleNow})::int AS waiting,
        COUNT(*) FILTER (WHERE c.aggregated AND c.work_status <> 'done' AND ${visibleNow})::int AS all
      FROM readable_conversations c
      WHERE c.follow_up AND ${shown}
    `,
    mailboxCountQuery(params.context, scope),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => ({
    id: row.id,
    mailboxId: row.mailbox_id,
    mailboxName: row.mailbox_name,
    subject: row.subject,
    participantSummary: row.participant_summary,
    latestMessageAt: toIso(row.latest_message_at),
    workStatus: row.work_status,
    assigneeUserIds: row.assignee_user_ids,
    revision: Number(row.revision),
    sourceFolderId: row.source_folder_id,
    unread: row.unread,
    flagged: row.flagged,
    hasAttachments: row.has_attachments,
    preview: row.preview || null,
  }));
  const last = pageRows.at(-1);
  const counts = countRows[0] ?? { mine: 0, unassigned: 0, waiting: 0, all: 0 };
  return ok({
    items,
    counts,
    mailboxCounts: mailboxCountRows.map((row) => ({
      mailboxId: row.mailbox_id,
      unread: row.unread,
      needsAction: row.needs_action,
    })),
    nextCursor: hasMore && last ? encodeCursor({ version: 1, view, userId, date: last.cursor_at, id: last.id }) : null,
  });
};
