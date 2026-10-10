import { toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { MailFocusView } from "../contracts";
import { conversationVisibleTo, isCurrentActorActive, readableMailboxGrants } from "./access";
import { capByCredentialScopes, type MailRequestContext, userBackedActor } from "./auth";
import { isUnassignedConversation, listLapsedAssignees } from "./collaborators";
import { isUnsentOutboundMessage } from "./conversation-timeline";
import {
  type AggregatedViewScope,
  loadAggregatedViewScope,
  staysInAggregatedViews,
  staysInAggregatedViewsAggregate,
} from "./folder-display";
import { isFollowUpConversation, isFollowUpMessage, isTrashOrJunkFolder } from "./follow-up-scope";

type SqlFragment = Bun.SQL.Query<unknown>;

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

const FOCUS_VIEWS: readonly MailFocusView[] = ["mine", "unassigned", "waiting", "all"];

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

const visibleNow = sql`(c.snoozed_until IS NULL OR c.snoozed_until <= now())`;

/** Conversations of a readable mailbox that the request may see: all of them, or only those assigned to the person. */
const conversationReadable = (context: MailRequestContext) =>
  sql`(readable.scope = 'mailbox' OR ${conversationVisibleTo(
    context.accessSubject.type === "user"
      ? { scope: "assigned", permission: "read", userId: context.accessSubject.userId }
      : { scope: "mailbox", permission: "read" },
    sql`c.id`,
  )})`;

const assignedTo = (userId: string | null) =>
  sql`EXISTS (SELECT 1 FROM mail.conversation_assignees a WHERE a.conversation_id = c.id AND a.user_id = ${userId}::uuid)`;

/**
 * The rule of one view for conversation `c`, besides "it needs follow-up". Mine and Waiting keep
 * conversations whose mail stays inside its folder; Unassigned and All leave them out with `aggregated`.
 */
const viewCondition = (view: MailFocusView, userId: string | null, unassigned: SqlFragment, aggregated: SqlFragment) => {
  if (view === "mine") return sql`c.work_status = 'needs_action' AND ${visibleNow} AND ${assignedTo(userId)}`;
  if (view === "waiting") return sql`c.work_status = 'waiting' AND ${visibleNow} AND ${assignedTo(userId)}`;
  if (view === "unassigned") return sql`c.work_status = 'needs_action' AND ${visibleNow} AND ${aggregated} AND ${unassigned}`;
  return sql`c.work_status <> 'done' AND ${visibleNow} AND ${aggregated}`;
};

type DbFocusStats = {
  mailbox_id: string;
  mine: number;
  unassigned: number;
  waiting: number;
  all: number;
  unread: number;
  needs_action: number;
  aggregated: number;
};

/**
 * Every count of the overview in one grouped pass over the messages of the readable mailboxes,
 * one row per mailbox: the view counts and the mailbox counts. Each conversation is decided once,
 * as in the Mail workspace view counts, instead of in a correlated check per conversation and count.
 * PostgreSQL prices the per-message folder checks so high that it would compile the query with JIT,
 * which took seconds in a few mailboxes with 50,000 messages while the counting itself takes about 100 ms.
 *
 * Every view covers open conversations that need follow-up. A mailbox counts unread mail outside
 * Trash and Junk, like All mail, and the conversations that need action; both leave out conversations
 * whose mail is kept inside its folders.
 */
const loadFocusStats = (params: FocusReader) =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return tx<DbFocusStats[]>`
      SELECT
        c.mailbox_id,
        COUNT(*) FILTER (WHERE c.follow_up AND ${viewCondition("mine", params.userId, params.unassigned, sql`c.aggregated`)})::int AS mine,
        COUNT(*) FILTER (WHERE c.follow_up AND ${viewCondition("unassigned", params.userId, params.unassigned, sql`c.aggregated`)})::int AS unassigned,
        COUNT(*) FILTER (WHERE c.follow_up AND ${viewCondition("waiting", params.userId, params.unassigned, sql`c.aggregated`)})::int AS waiting,
        COUNT(*) FILTER (WHERE c.follow_up AND ${viewCondition("all", params.userId, params.unassigned, sql`c.aggregated`)})::int AS all,
        COUNT(*) FILTER (WHERE c.aggregated AND c.unread)::int AS unread,
        COUNT(*) FILTER (WHERE c.aggregated AND c.follow_up AND c.work_status = 'needs_action' AND ${visibleNow})::int AS needs_action,
        COUNT(*) FILTER (WHERE c.aggregated)::int AS aggregated
      FROM (
        SELECT
          c.id,
          c.mailbox_id,
          c.work_status,
          c.snoozed_until,
          bool_or(${isFollowUpMessage(sql`placement`, sql`outbox.id IS NOT NULL`)}) AS follow_up,
          COALESCE(bool_or(
            placement.message_id IS NOT NULL
            AND NOT ('\\Seen' = ANY(placement.flags))
            AND NOT ${isTrashOrJunkFolder(sql`placement.folder_id`)}
          ), false) AS unread,
          ${staysInAggregatedViewsAggregate(sql`placement.folder_id`, params.scope)} AS aggregated
        FROM (${readableMailboxes(params.context)}) readable
        JOIN mail.conversations c ON c.mailbox_id = readable.mailbox_id
        JOIN mail.conversation_messages link ON link.conversation_id = c.id
        LEFT JOIN mail.message_placements placement
          ON placement.message_id = link.message_id
         AND placement.deleted_at IS NULL
        LEFT JOIN mail.outbox_submissions outbox
          ON outbox.message_id = link.message_id
         AND outbox.state <> 'cancelled'
        WHERE ${conversationReadable(params.context)}
        GROUP BY c.id
        -- A conversation shows while one of its messages is filed somewhere or on its way out.
        HAVING bool_or(placement.message_id IS NOT NULL OR outbox.id IS NOT NULL)
      ) c
      GROUP BY c.mailbox_id
      ORDER BY c.mailbox_id
    `;
  });

/** Rows come in mailbox ID order, so every caller sees the same list. */
const toMailboxCounts = (rows: readonly DbFocusStats[]): MailFocusMailboxCounts[] =>
  rows.filter((row) => row.aggregated > 0).map((row) => ({ mailboxId: row.mailbox_id, unread: row.unread, needsAction: row.needs_action }));

/** What every focus read of one request shares: who reads, which mailboxes, and their rules. */
type FocusReader = {
  context: MailRequestContext;
  userId: string | null;
  scope: AggregatedViewScope;
  unassigned: SqlFragment;
  excludedMailboxIds?: string[];
};

const loadFocusReader = async (context: MailRequestContext, excludedMailboxIds?: string[]): Promise<FocusReader> => {
  const readableMailboxIds = (await readableMailboxes(context)).map((row) => row.mailbox_id);
  const [lapsedAssignees, scope] = await Promise.all([
    listLapsedAssignees({ mailboxIds: readableMailboxIds }),
    loadAggregatedViewScope(readableMailboxIds),
  ]);
  return {
    context,
    userId: userBackedActor(context)?.id ?? null,
    scope,
    unassigned: isUnassignedConversation(lapsedAssignees),
    excludedMailboxIds,
  };
};

const canReadFocus = async (context: MailRequestContext): Promise<boolean> =>
  (await isCurrentActorActive(context)) && capByCredentialScopes(context, "read") !== "none";

export const listMailboxCounts = async (context: MailRequestContext): Promise<Result<MailFocusMailboxCounts[]>> => {
  if (!(await canReadFocus(context))) return fail(err.forbidden("Access denied"));
  return ok(toMailboxCounts(await loadFocusStats(await loadFocusReader(context))));
};

/** Hidden mailboxes leave the view counts but keep their own counts. */
const toFocusCounts = (rows: readonly DbFocusStats[], excludedMailboxIds?: string[]): MailFocusCounts => {
  const excluded = new Set(excludedMailboxIds);
  const counts: MailFocusCounts = { mine: 0, unassigned: 0, waiting: 0, all: 0 };
  for (const row of rows) {
    if (excluded.has(row.mailbox_id)) continue;
    for (const view of FOCUS_VIEWS) counts[view] += row[view];
  }
  return counts;
};

type FocusPage = { items: MailFocusItem[]; nextCursor: string | null };

/**
 * One page of a view: the newest matching conversations of each readable mailbox, merged. Every
 * mailbox walks its own index by recency and stops after one page, so a page reads about one page
 * of conversations per mailbox instead of deciding every conversation of every mailbox, and the
 * details of a row are read only for the conversations on the page.
 */
const loadFocusPage = async (focus: FocusReader, view: MailFocusView, cursor: FocusCursor | null, limit: number): Promise<FocusPage> => {
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return tx<DbFocusItem[]>`
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
      FROM (
        SELECT page.*
        FROM (${readableMailboxes(focus.context)}) readable
        CROSS JOIN LATERAL (
          SELECT c.*
          FROM mail.conversations c
          WHERE c.mailbox_id = readable.mailbox_id
            AND NOT (c.mailbox_id = ANY(${toPgUuidArray(focus.excludedMailboxIds)}::uuid[]))
            AND ${conversationReadable(focus.context)}
            AND ${viewCondition(view, focus.userId, focus.unassigned, staysInAggregatedViews(sql`c.id`, focus.scope))}
            AND ${isFollowUpConversation(sql`c.id`)}
            AND (
              ${cursor?.id ?? null}::uuid IS NULL
              OR (c.latest_message_at, c.id) < (${cursor?.date ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
            )
          ORDER BY c.latest_message_at DESC, c.id DESC
          LIMIT ${limit + 1}
        ) page
        ORDER BY page.latest_message_at DESC, page.id DESC
        LIMIT ${limit + 1}
      ) c
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
      ORDER BY c.latest_message_at DESC, c.id DESC
    `;
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
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
    })),
    nextCursor: hasMore && last ? encodeCursor({ version: 1, view, userId: focus.userId, date: last.cursor_at, id: last.id }) : null,
  };
};

const pageLimit = (limit: number | undefined) => Math.min(Math.max(Math.floor(limit ?? 50), 1), 100);

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
}): Promise<Result<FocusPage & { counts: MailFocusCounts; mailboxCounts: MailFocusMailboxCounts[] }>> => {
  if (!(await canReadFocus(params.context))) return fail(err.forbidden("Access denied"));

  const view = params.view ?? "mine";
  const userId = userBackedActor(params.context)?.id ?? null;
  if ((view === "mine" || view === "waiting") && !userId) {
    return fail(err.badInput(`The ${view} view requires a user-backed actor`));
  }
  const cursor = decodeCursor(params.cursor, view, userId);
  if (!cursor.ok) return cursor;
  const focus = await loadFocusReader(params.context, params.excludedMailboxIds);
  const [page, stats] = await Promise.all([loadFocusPage(focus, view, cursor.data, pageLimit(params.limit)), loadFocusStats(focus)]);
  return ok({ ...page, counts: toFocusCounts(stats, params.excludedMailboxIds), mailboxCounts: toMailboxCounts(stats) });
};

/**
 * The first page of every view with the counts they share, for a person opening the overview: each
 * view then opens at once, and the counts are computed once instead of once per view.
 */
export const listFocusOverview = async (params: {
  context: MailRequestContext;
  limit?: number;
  excludedMailboxIds?: string[];
}): Promise<Result<{ pages: Record<MailFocusView, FocusPage>; counts: MailFocusCounts; mailboxCounts: MailFocusMailboxCounts[] }>> => {
  if (!(await canReadFocus(params.context))) return fail(err.forbidden("Access denied"));
  if (!userBackedActor(params.context)) return fail(err.badInput("The focus overview requires a user-backed actor"));
  const focus = await loadFocusReader(params.context, params.excludedMailboxIds);
  const limit = pageLimit(params.limit);
  const [stats, mine, unassigned, waiting, all] = await Promise.all([
    loadFocusStats(focus),
    loadFocusPage(focus, "mine", null, limit),
    loadFocusPage(focus, "unassigned", null, limit),
    loadFocusPage(focus, "waiting", null, limit),
    loadFocusPage(focus, "all", null, limit),
  ]);
  return ok({
    pages: { mine, unassigned, waiting, all },
    counts: toFocusCounts(stats, params.excludedMailboxIds),
    mailboxCounts: toMailboxCounts(stats),
  });
};
