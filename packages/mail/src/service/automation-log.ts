import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import type { AutomationLogDetail, AutomationLogItem, AutomationLogPage, AutomationLogQuery } from "../contracts";
import { automationLogItemSchema, automationLogQuerySchema } from "../contracts";
import { conversationVisibleTo, requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
/** Mailboxes have no time-zone setting; audit calendar days therefore use UTC. */
export const MAIL_AUTOMATION_LOG_TIME_ZONE = "UTC";
const cursorSchema = z.object({
  at: z
    .string()
    .max(100)
    .refine((at) => Number.isFinite(Date.parse(at))),
  id: z.string().uuid(),
});
const encodeCursor = (value: z.infer<typeof cursorSchema>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (value: string | undefined) => {
  if (!value) return ok(null);
  try {
    return ok(cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))));
  } catch {
    return fail(err.badInput("Invalid automation log cursor"));
  }
};

type LogRow = {
  id: string;
  item: unknown;
  chain: AutomationLogDetail["chain"];
  conversation_id: string | null;
  run_id: string | null;
  assignment_user_id: string | null;
  undone_at: Date | null;
  undone_by_id: string | null;
  undone_by_name: string | null;
  provenance_current: boolean;
  changed_by_id: string | null;
  changed_by_name: string | null;
  changed_at: Date | null;
  cursor_at: string;
  undo_kept: NonNullable<AutomationLogItem["undo"]["kept"]>;
  undo_reverted: AutomationLogItem["effects"];
};
const rowColumns = () =>
  sql.unsafe(`log.*, log.created_at::text AS cursor_at,
  (assignment.run_id = log.run_id AND assignment.user_id = log.assignment_user_id AND assignment.changed_at IS NULL
   AND (SELECT count(*) FROM mail.conversation_assignees current WHERE current.conversation_id = log.conversation_id) = 1
   AND EXISTS (SELECT 1 FROM mail.conversation_assignees current WHERE current.conversation_id = log.conversation_id AND current.principal_id = log.assignment_user_id)) AS provenance_current,
  assignment.changed_by_id, assignment.changed_by_name, assignment.changed_at`);
const rowFrom = () =>
  sql.unsafe(
    `FROM mail.automation_log log LEFT JOIN mail.automation_assignment assignment ON assignment.conversation_id = log.conversation_id`,
  );
// Stored snapshots predate undo.at; all undo state is derived from the authoritative columns.
const storedItemSchema = automationLogItemSchema.omit({ undo: true });
/** Frozen evidence only: retired rules never expose an executable Undo or Redo. */
const itemFromRow = async (row: LogRow, _db: typeof sql = sql): Promise<AutomationLogItem> => ({
  ...storedItemSchema.parse(row.item),
  undo: {
    state: row.undone_at ? "done" : "none",
    reason: null,
    by: row.undone_by_id ? { userId: row.undone_by_id, name: row.undone_by_name ?? "" } : null,
    at: row.undone_at?.toISOString() ?? null,
    kept: row.undo_kept ?? [],
    reverted: row.undo_reverted ?? [],
  },
});

const filterCondition = (filter: string) =>
  filter === "assignments"
    ? sql`log.item->'effects' @> '[{"kind":"assign"}]'::jsonb`
    : filter === "uncertain"
      ? sql`log.item->>'outcome' = 'uncertain'`
      : filter === "skipped"
        ? sql`(log.item->>'outcome' = 'skipped' OR log.item->'reasons' @> '[{"kind":"skipped_upper_rule"}]'::jsonb
    OR log.item->'reasons' @> '[{"kind":"already_assigned"}]'::jsonb OR log.item->'reasons' @> '[{"kind":"undone_before"}]'::jsonb)`
        : filter === "manual"
          ? sql`log.item->'by'->>'kind' = 'person'`
          : sql`true`;
const searchCondition = (q: string | undefined) =>
  !q
    ? sql`true`
    : sql`strpos(lower(concat_ws(' ',
  log.item #>> '{conversation,subject}', log.item #>> '{conversation,from,name}', log.item #>> '{conversation,from,email}',
  log.item #>> '{by,name}', (SELECT string_agg(effect #>> '{target,name}', ' ') FROM jsonb_array_elements(log.item->'effects') effect)
)), lower(${q})) > 0`;

export const listAutomationLog = async (
  context: MailRequestContext,
  mailboxId: string,
  input: AutomationLogQuery = {},
): Promise<Result<AutomationLogPage>> => {
  const parsed = automationLogQuerySchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput("Invalid automation log query"));
  const query = parsed.data,
    day = query.day ?? new Date().toISOString().slice(0, 10);
  const cursor = decodeCursor(query.before);
  if (!cursor.ok) return cursor;
  const access = await requireMailboxAccess(context, mailboxId, "read");
  if (!access.ok) return access;
  const where = sql`log.mailbox_id = ${mailboxId}::uuid AND log.created_at >= ${`${day}T00:00:00Z`}::timestamptz
    AND log.created_at < ${`${day}T00:00:00Z`}::timestamptz + interval '1 day'
    AND ${conversationVisibleTo(access.data, sql`log.conversation_id`)} AND ${searchCondition(query.q)}`;
  // One read transaction makes the chips and page agree under concurrent workflow writes.
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [counts] = await tx<AutomationLogPage["counts"][]>`
      SELECT count(*)::int AS "all",
        count(*) FILTER (WHERE ${filterCondition("assignments")})::int AS assignments,
        count(*) FILTER (WHERE ${filterCondition("uncertain")})::int AS uncertain,
        count(*) FILTER (WHERE ${filterCondition("skipped")})::int AS skipped,
        count(*) FILTER (WHERE ${filterCondition("manual")})::int AS manual
      FROM mail.automation_log log WHERE ${where}`;
    const rows = await tx<LogRow[]>`SELECT ${rowColumns()} ${rowFrom()} WHERE ${where} AND ${filterCondition(query.filter)}
      AND (${cursor.data?.at ?? null}::timestamptz IS NULL OR (log.created_at, log.id) < (${cursor.data?.at ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
      ORDER BY log.created_at DESC, log.id DESC LIMIT ${query.limit + 1}`;
    const page = rows.slice(0, query.limit),
      last = page.at(-1);
    return ok({
      day,
      counts: counts ?? { all: 0, assignments: 0, uncertain: 0, skipped: 0, manual: 0 },
      items: await Promise.all(page.map((row) => itemFromRow(row, tx))),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
    });
  });
};

export const getAutomationLogItem = async (
  context: MailRequestContext,
  mailboxId: string,
  itemId: string,
): Promise<Result<AutomationLogDetail>> => {
  const allowed = await requireMailboxAccess(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [row] = await sql<
    LogRow[]
  >`SELECT ${rowColumns()} ${rowFrom()} WHERE log.mailbox_id = ${mailboxId}::uuid AND log.id = ${itemId}::uuid
    AND ${conversationVisibleTo(allowed.data, sql`log.conversation_id`)}`;
  if (!row) return fail(err.notFound("Automation log entry"));
  const item = await itemFromRow(row);
  const workflowId = item.by.kind === "rule" ? item.by.workflowId : null;
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const [calls] = await sql<{ run: number; today: number }[]>`
    SELECT count(*) FILTER (WHERE task.run_id = ${row.run_id}::uuid)::int AS run,
      count(*) FILTER (WHERE task.created_at >= ${today}::timestamptz AND task.created_at < ${today}::timestamptz + interval '1 day')::int AS today
    FROM ai.workflow_task task JOIN workflows.run run ON run.id = task.run_id
    WHERE run.app_id = 'mail' AND run.scope_id = ${mailboxId} AND run.workflow_id = ${workflowId}::uuid
      AND (task.run_id = ${row.run_id}::uuid OR (task.created_at >= ${today}::timestamptz AND task.created_at < ${today}::timestamptz + interval '1 day'))
      AND ${allowed.data.scope === "mailbox" ? sql`true` : sql`EXISTS (SELECT 1 FROM mail.conversations conversation WHERE conversation.short_id = run.context #>> '{source,conversation,id}' AND conversation.mailbox_id = ${mailboxId}::uuid AND ${conversationVisibleTo(allowed.data, sql`conversation.id`)})`}`;
  return ok({ ...item, chain: row.chain, aiCalls: { run: calls?.run ?? 0, today: calls?.today ?? 0, limit: null } });
};

export const getConversationAutomationTrace = async (
  context: MailRequestContext,
  mailboxId: string,
  conversationId: string,
): Promise<Result<{ items: AutomationLogItem[] }>> => {
  const allowed = await requireMailboxAccess(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [visible] = await sql<
    { visible: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM mail.conversations conversation WHERE conversation.id = ${conversationId}::uuid AND conversation.mailbox_id = ${mailboxId}::uuid AND ${conversationVisibleTo(allowed.data, sql`conversation.id`)}) AS visible`;
  if (!visible?.visible) return fail(err.notFound("Conversation"));
  const rows = await sql<
    LogRow[]
  >`SELECT ${rowColumns()} ${rowFrom()} WHERE log.mailbox_id = ${mailboxId}::uuid AND log.conversation_id = ${conversationId}::uuid ORDER BY log.created_at DESC, log.id DESC LIMIT 10`;
  return ok({ items: await Promise.all(rows.map((row) => itemFromRow(row))) });
};
