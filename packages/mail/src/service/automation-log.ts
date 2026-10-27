import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import type {
  ActorCommandInput,
  AutomationLogDetail,
  AutomationLogItem,
  AutomationLogPage,
  AutomationLogQuery,
  MailCommand,
  RemoteMessagePrecondition,
} from "../contracts";
import { automationLogItemSchema, automationLogQuerySchema, standardMessageFlagSchema } from "../contracts";
import { conversationVisibleTo, requireMailboxAccess } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import {
  type AutomationEffectRow,
  automationEffectCurrent,
  automationEffectProviderRef,
  automationEffectsPending,
  loadAutomationEffects,
} from "./automation-effect-state";
import { updateConversationCollaborationInTransaction } from "./collaboration";
import { createActorCommandsInTransaction, enqueueCreatedActorCommands } from "./commands";
import { mailLive } from "./live";
import { updateWorkflowConversationLocalTagInTransaction } from "./local-tags";

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
const rowColumns = sql.unsafe(`log.*, log.created_at::text AS cursor_at,
  (assignment.run_id = log.run_id AND assignment.user_id = log.assignment_user_id AND assignment.changed_at IS NULL
   AND (SELECT count(*) FROM mail.conversation_assignees current WHERE current.conversation_id = log.conversation_id) = 1
   AND EXISTS (SELECT 1 FROM mail.conversation_assignees current WHERE current.conversation_id = log.conversation_id AND current.user_id = log.assignment_user_id)) AS provenance_current,
  assignment.changed_by_id, assignment.changed_by_name, assignment.changed_at`);
const rowFrom = sql.unsafe(
  `FROM mail.automation_log log LEFT JOIN mail.automation_assignment assignment ON assignment.conversation_id = log.conversation_id`,
);
// Stored snapshots predate undo.at; all undo state is derived from the authoritative columns.
const storedItemSchema = automationLogItemSchema.omit({ undo: true });
const itemFromRow = async (row: LogRow, db: typeof sql = sql): Promise<AutomationLogItem> => {
  const item = storedItemSchema.parse(row.item);
  const changedBy = row.changed_by_id ? { userId: row.changed_by_id, name: row.changed_by_name ?? "" } : null;
  const undoneBy = row.undone_by_id ? { userId: row.undone_by_id, name: row.undone_by_name ?? "" } : null;
  const effects = await loadAutomationEffects(db, row.run_id, row.conversation_id);
  let available = row.assignment_user_id !== null && row.provenance_current;
  const currentKept: NonNullable<AutomationLogItem["undo"]["kept"]> = [];
  if (row.assignment_user_id && !row.provenance_current && !row.undone_at)
    currentKept.push({ kind: "assign", reason: "changed_by_person" });
  for (const effect of effects) {
    if (!effect.undone && row.conversation_id) {
      const current = await automationEffectCurrent(db, effect, row.conversation_id);
      if (current === "current") available = true;
      else if (current !== "pending") currentKept.push({ kind: reversibleKind(effect.effect), reason: current });
    }
  }
  const reversible = Boolean(row.assignment_user_id || effects.length);
  const pending = await automationEffectsPending(db, row.run_id, row.conversation_id);
  const undo: AutomationLogItem["undo"] =
    item.by.kind !== "rule"
      ? { state: "none", reason: null, by: null, at: null }
      : pending && !row.undone_at
        ? { state: "not_possible", reason: "provider_pending", by: null, at: null }
        : !reversible
          ? { state: "none", reason: null, by: null, at: null }
          : !row.conversation_id
            ? { state: "not_possible", reason: "conversation_gone", by: null, at: null }
            : row.undone_at && (!row.assignment_user_id || !row.changed_at || effects.some((effect) => effect.undone && !effect.changed_at))
              ? { state: "done", reason: null, by: undoneBy, at: row.undone_at.toISOString() }
              : available
                ? { state: "available", reason: null, by: null, at: null }
                : { state: "not_possible", reason: "changed_by_person", by: changedBy, at: row.changed_at?.toISOString() ?? null };
  return { ...item, undo: { ...undo, kept: row.undone_at ? (row.undo_kept ?? []) : currentKept, reverted: row.undo_reverted ?? [] } };
};

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
    const rows = await tx<LogRow[]>`SELECT ${rowColumns} ${rowFrom} WHERE ${where} AND ${filterCondition(query.filter)}
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
  const [row] = await sql<LogRow[]>`SELECT ${rowColumns} ${rowFrom} WHERE log.mailbox_id = ${mailboxId}::uuid AND log.id = ${itemId}::uuid
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
  >`SELECT ${rowColumns} ${rowFrom} WHERE log.mailbox_id = ${mailboxId}::uuid AND log.conversation_id = ${conversationId}::uuid ORDER BY log.created_at DESC, log.id DESC LIMIT 10`;
  return ok({ items: await Promise.all(rows.map((row) => itemFromRow(row))) });
};

type UndoReason = "changed_by_person" | "conversation_gone" | "provider_pending";
const cannotUndo = (reason: UndoReason, item: AutomationLogItem) =>
  fail({
    code: "mail.automation.undo_not_possible",
    status: 409,
    message:
      reason === "provider_pending"
        ? "Wait for the provider commands to finish before undoing or restoring these effects"
        : "The rule effects can no longer be restored or undone",
    reason,
    item: {
      ...item,
      undo:
        item.undo.state === "not_possible" && item.undo.reason === reason
          ? item.undo
          : { ...item.undo, state: "not_possible", reason, by: null, at: null },
    },
  });

/** Undo one conversation group; provider changes commit as normal durable commands. */
export const changeAutomationLogEffects = async (
  context: MailRequestContext,
  mailboxId: string,
  itemId: string,
  operation: "undo" | "redo",
): Promise<Result<{ item: AutomationLogItem }>> => {
  const commands: MailCommand[] = [];
  try {
    const outcome = await sql.begin(async (tx) => {
      const allowed = await requireMailboxAccess(context, mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      if (allowed.data.scope !== "mailbox") return fail(err.forbidden("Automation undo requires mailbox-wide write access"));
      // Commands and local tags lock the mailbox exclusively before the conversation.
      await tx`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const [target] = await tx<{ conversation_id: string | null }[]>`SELECT conversation_id FROM mail.automation_log
        WHERE id = ${itemId}::uuid AND mailbox_id = ${mailboxId}::uuid`;
      if (!target) return fail(err.notFound("Automation log entry"));
      const [conversation] = target.conversation_id
        ? await tx<{ revision: string | number }[]>`SELECT revision FROM mail.conversations
        WHERE id = ${target.conversation_id}::uuid AND mailbox_id = ${mailboxId}::uuid FOR UPDATE`
        : [];
      const [row] = await tx<
        LogRow[]
      >`SELECT ${rowColumns} ${rowFrom} WHERE log.id = ${itemId}::uuid AND log.mailbox_id = ${mailboxId}::uuid FOR UPDATE OF log`;
      if (!row) return fail(err.notFound("Automation log entry"));
      const item = await itemFromRow(row, tx);
      if (!target.conversation_id || !conversation) return cannotUndo("conversation_gone", item);
      if (item.by.kind !== "rule") return cannotUndo("changed_by_person", item);
      const conversationId = target.conversation_id;
      const person = userBackedActor(context);
      const userId = person?.id ?? (context.actor.kind === "service_account" ? context.actor.serviceAccount.id : "");
      const name = person?.displayName ?? (context.actor.kind === "service_account" ? context.actor.serviceAccount.name : "");
      if (operation === "undo" && row.undone_at && item.undo.state === "done") return ok({ item });
      if (operation === "redo" && (!row.undone_at || row.undone_by_id !== userId)) return cannotUndo("changed_by_person", item);
      if (await automationEffectsPending(tx, row.run_id, conversationId)) return cannotUndo("provider_pending", item);
      const snapshots = await loadAutomationEffects(tx, row.run_id, conversationId);
      const candidates: AutomationEffectRow[] = [];
      const kept: NonNullable<AutomationLogItem["undo"]["kept"]> = [];
      for (const effect of snapshots) {
        if (effect.undone !== (operation === "redo")) continue;
        const current = await automationEffectCurrent(tx, effect, conversationId);
        if (current === "current") candidates.push(effect);
        else if (current !== "pending") kept.push({ kind: reversibleKind(effect.effect), reason: current });
      }
      let assignmentReady = Boolean(row.assignment_user_id && row.provenance_current && operation === "undo");
      const assignmentWasUndone = row.undo_reverted?.some((effect) => effect.kind === "assign") ?? false;
      if (row.assignment_user_id && operation === "redo" && assignmentWasUndone) {
        const [state] = await tx<{ ready: boolean }[]>`SELECT EXISTS (SELECT 1 FROM mail.automation_assignment assignment
          WHERE assignment.conversation_id = ${conversationId}::uuid AND assignment.run_id = ${row.run_id}::uuid
            AND assignment.changed_at IS NULL AND NOT EXISTS (SELECT 1 FROM mail.conversation_assignees current
              WHERE current.conversation_id = assignment.conversation_id)) AS ready`;
        assignmentReady = state?.ready ?? false;
      }
      if (row.assignment_user_id && (operation === "undo" || assignmentWasUndone) && !assignmentReady)
        kept.push({ kind: "assign", reason: "changed_by_person" });
      if (!assignmentReady && !candidates.length) return cannotUndo("changed_by_person", { ...item, undo: { ...item.undo, kept } });
      // Redo is limited to the subset actually reverted; a later personal change remains untouched.
      const reverted: AutomationLogItem["effects"] = [];
      const operationEffects: AutomationLogItem["effects"] = [];
      const reasons: AutomationLogItem["reasons"] = [];
      const revision = async () => {
        const [current] = await tx<
          { revision: string | number }[]
        >`SELECT revision FROM mail.conversations WHERE id = ${conversationId}::uuid`;
        return Number(current!.revision);
      };
      if (assignmentReady) {
        const mutation = await updateConversationCollaborationInTransaction({
          context,
          mailboxId,
          conversationId,
          db: tx,
          input: { expectedRevision: await revision(), assigneeUserIds: operation === "undo" ? [] : [row.assignment_user_id!] },
          activityMetadata: { automationLogOperation: operation, automationLogId: itemId },
        });
        if (!mutation.ok) throw mutation.error;
        if (operation === "undo")
          await tx`INSERT INTO mail.automation_assignment_undone (conversation_id, workflow_id, mailbox_id)
          VALUES (${conversationId}::uuid, ${item.by.workflowId}::uuid, ${mailboxId}::uuid) ON CONFLICT DO NOTHING`;
        else
          await tx`DELETE FROM mail.automation_assignment_undone WHERE conversation_id = ${conversationId}::uuid AND workflow_id = ${item.by.workflowId}::uuid`;
        const assignmentEffects = item.effects.filter((effect) => effect.kind === "assign");
        reverted.push(...assignmentEffects);
        operationEffects.push(...(operation === "undo" ? [{ kind: "unassign" as const }] : assignmentEffects));
        const assignmentName = assignmentEffects.map((effect) => effect.target.name).join(", ");
        reasons.push({
          kind: "manual",
          before: operation === "undo" ? { kind: "user", name: assignmentName, byRule: item.by.name } : null,
          after: operation === "redo" ? { kind: "user", name: assignmentName } : null,
        });
      }
      const providerStates = new Map<string, RemoteMessagePrecondition>();
      for (const effect of candidates.sort((a, b) => Number(a.effect_class === "placement") - Number(b.effect_class === "placement"))) {
        const value = operation === "undo" ? effect.before_value : effect.after_value;
        let commandId: string | null = null;
        if (effect.effect_class === "tag") {
          const mutation = await updateWorkflowConversationLocalTagInTransaction({
            db: tx,
            context,
            mailboxId,
            conversationId,
            expectedRevision: await revision(),
            tagId: effect.target_id,
            operation: value ? "add" : "remove",
          });
          if (!mutation.ok) throw mutation.error;
        } else if (effect.effect_class === "status") {
          const mutation = await updateConversationCollaborationInTransaction({
            context,
            mailboxId,
            conversationId,
            db: tx,
            input: { expectedRevision: await revision(), workStatus: z.enum(["needs_action", "waiting", "done"]).parse(value) },
            activityMetadata: { automationLogOperation: operation, automationLogId: itemId },
          });
          if (!mutation.ok) throw mutation.error;
        } else {
          const ref = await automationEffectProviderRef(tx, effect);
          if (!ref) throw err.conflict("Provider target changed during undo");
          let expectedRemoteState = providerStates.get(ref.id);
          if (!expectedRemoteState) {
            const [placement] = await tx<{ flags: string[]; keywords: string[] }[]>`SELECT flags, keywords
              FROM mail.message_placements WHERE remote_message_ref_id = ${ref.id}::uuid`;
            if (!placement) throw err.conflict("Provider target changed during undo");
            expectedRemoteState = {
              flags: placement.flags.flatMap((flag) => {
                const parsed = standardMessageFlagSchema.safeParse(flag.replace(/^\\/u, "").toLowerCase());
                return parsed.success ? [parsed.data] : [];
              }),
              keywords: [...placement.keywords],
            };
          }
          const input: ActorCommandInput =
            effect.effect_class === "placement"
              ? {
                  kind: "move",
                  messageId: effect.target_id,
                  sourceFolderId: ref.folder_id,
                  destinationFolderId: String(value),
                  expectedRemoteState,
                  idempotencyKey: `automation:${itemId}:${operation}:${effect.id}:${crypto.randomUUID()}`,
                }
              : {
                  kind: "change_message_state",
                  messageId: effect.target_id,
                  folderId: ref.folder_id,
                  expectedRemoteState,
                  change: {
                    addFlags: effect.effect_class === "flag" && value ? [publicFlag(effect.value)] : [],
                    removeFlags: effect.effect_class === "flag" && !value ? [publicFlag(effect.value)] : [],
                    addKeywords: effect.effect_class === "keyword" && value ? [effect.value] : [],
                    removeKeywords: effect.effect_class === "keyword" && !value ? [effect.value] : [],
                  },
                  idempotencyKey: `automation:${itemId}:${operation}:${effect.id}:${crypto.randomUUID()}`,
                };
          const created = await createActorCommandsInTransaction(
            { context, mailboxId, inputs: [{ ...input, remoteMessageRefId: ref.id }] },
            tx,
          );
          if (input.kind === "change_message_state") {
            const update = <T extends string>(values: T[] | undefined, add: T[], remove: T[]) => [
              ...new Set([...(values ?? []).filter((value) => !remove.includes(value)), ...add]),
            ];
            providerStates.set(ref.id, {
              flags: update(expectedRemoteState.flags, input.change.addFlags, input.change.removeFlags),
              keywords: update(expectedRemoteState.keywords, input.change.addKeywords, input.change.removeKeywords),
            });
          }
          commands.push(...created);
          commandId = created[0]!.id;
        }
        await tx`UPDATE mail.automation_effect SET undone = ${operation === "undo"}, changed_at = NULL,
          command_id = COALESCE(${commandId}::uuid, command_id) WHERE id = ${effect.id}::uuid`;
        if (operation === "undo")
          await tx`INSERT INTO mail.automation_effect_undone (conversation_id, workflow_id, mailbox_id, effect_class)
          VALUES (${conversationId}::uuid, ${item.by.workflowId}::uuid, ${mailboxId}::uuid, ${effect.effect_class}) ON CONFLICT DO NOTHING`;
        else
          await tx`DELETE FROM mail.automation_effect_undone WHERE conversation_id = ${conversationId}::uuid
          AND workflow_id = ${item.by.workflowId}::uuid AND effect_class = ${effect.effect_class}
          AND NOT EXISTS (SELECT 1 FROM mail.automation_effect remaining JOIN workflows.run remaining_run ON remaining_run.id = remaining.run_id
            WHERE remaining_run.workflow_id = ${item.by.workflowId}::uuid AND remaining.conversation_id = ${conversationId}::uuid AND remaining.effect_class = ${effect.effect_class} AND remaining.undone)`;
        reverted.push(effect.effect);
        operationEffects.push(operation === "redo" ? effect.effect : await inverseEffect(tx, effect));
      }
      await tx`UPDATE mail.automation_log SET undone_at = ${operation === "undo" ? new Date() : null}::timestamptz,
        undone_by_id = ${operation === "undo" ? userId : null}, undone_by_name = ${operation === "undo" ? name : null},
        undo_kept = ${kept}::jsonb, undo_reverted = ${reverted}::jsonb WHERE id = ${itemId}::uuid`;
      const operationId = crypto.randomUUID();
      const operationItem: AutomationLogItem = {
        id: operationId,
        at: new Date().toISOString(),
        conversation: item.conversation,
        by: { kind: "person", userId, name },
        outcome: "manual_change",
        effects: operationEffects,
        reasons,
        undo: { state: "none", reason: null, by: null, at: null, kept: [], reverted: [] },
      };
      await tx`INSERT INTO mail.automation_log (id, mailbox_id, conversation_id, item, created_at)
        VALUES (${operationId}::uuid, ${mailboxId}::uuid, ${conversationId}::uuid, ${operationItem}, ${operationItem.at}::timestamptz)`;
      const [updated] = await tx<LogRow[]>`SELECT ${rowColumns} ${rowFrom} WHERE log.id = ${itemId}::uuid`;
      if (!updated) throw new Error("Updated automation log disappeared");
      return ok({ item: await itemFromRow(updated, tx) });
    });
    if (outcome.ok) {
      await enqueueCreatedActorCommands(commands);
      mailLive.wake();
    }
    return outcome;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    throw error;
  }
};

const reversibleKind = (effect: AutomationLogItem["effects"][number]): NonNullable<AutomationLogItem["undo"]["kept"]>[number]["kind"] => {
  if (effect.kind === "comment" || effect.kind === "summary") throw new Error("Non-reversible effect has provenance");
  return effect.kind;
};
const publicFlag = (value: string): "seen" | "answered" | "flagged" | "draft" =>
  z.enum(["seen", "answered", "flagged", "draft"]).parse(value.slice(1).toLowerCase());

const inverseEffect = async (db: typeof sql, effect: AutomationEffectRow): Promise<AutomationLogItem["effects"][number]> => {
  const original = effect.effect;
  if (original.kind === "tag" || original.kind === "untag") return { kind: original.kind === "tag" ? "untag" : "tag", name: original.name };
  if (original.kind === "read" || original.kind === "unread") return { kind: original.kind === "read" ? "unread" : "read" };
  if (original.kind === "flag" || original.kind === "keyword") return { ...original, present: !original.present };
  if (original.kind === "status") return { kind: "status", status: z.enum(["needs_action", "waiting", "done"]).parse(effect.before_value) };
  if (original.kind === "move" || original.kind === "archive") {
    const [folder] = await db<{ name: string }[]>`SELECT name FROM mail.folders WHERE id = ${String(effect.before_value)}::uuid`;
    return { kind: "move", folder: folder?.name ?? "" };
  }
  throw new Error("Unexpected reversible effect kind");
};
