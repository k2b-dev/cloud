import type { Message } from "@k2b/nessi";
import { type SQL, sql } from "bun";
import { getCapability } from "../_internal/registry";
import { logger } from "../services/logging";
import {
  createMandate,
  MANDATE_POLICY_DENIED_MESSAGE,
  type Mandate,
  type MandatePolicyV1,
  MandatePolicyV1Schema,
  pauseMandate,
  resumeMandate,
  revokeMandate,
  type TaskGrant,
  TaskGrantsSchema,
  updateMandatePolicy,
  validateMandateIssueAuthority,
} from "../services/mandates";
import { parsePgJsonValue, toPgUuidArray } from "../services/postgres";
import { coreSettings } from "../services/settings/api";
import { canonicalLocale } from "../shared/locale";
import { chatTaskName } from "./chat-task-contracts";
import {
  type ChatTaskReason,
  type ChatTaskReasonCode,
  chatTaskLocale,
  chatTaskNeedsNewTime,
  chatTaskReasonSentence,
  chatTaskReasonState,
  chatTaskStopSentence,
} from "./chat-task-reasons";
import { buildBlocksFromMessages } from "./protocol";
import { withAiShortIdForDb } from "./short-id";
import { aiConversations } from "./store";
import { toolOutcome, toolWording } from "./tool-wording";
import { finishAiTurnAbort } from "./turn-abort";
import type { AiChatTurnRunConfig, AiStoredMessage, AiTurnStatus } from "./types";

/** Run history and transcripts are operational evidence; 90 days matches capability execution history.
 * Fixed platform constant, not configurable. */
export const AI_CHAT_TASK_RUN_RETENTION_DAYS = 90;

export type AiChatTaskState = "active" | "paused" | "completed" | "needs_attention";
export type AiChatTaskSchedule = { kind: "once"; runAt: string } | { kind: "cron"; cron: string };
export type AiChatTask = {
  title: string | null;
  name: string;
  locale: string | null;
  reasonCode: ChatTaskReasonCode | null;
  reasonAt: string | null;
  id: string;
  shortId: string;
  chatId: string;
  chatTitle: string;
  conversationId: string;
  sponsorUserId: string;
  mandateId: string | null;
  mandateRevision: number | null;
  grants: TaskGrant[];
  prompt: string;
  schedule: AiChatTaskSchedule;
  timezone: string;
  state: AiChatTaskState;
  revision: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiChatTaskOccurrenceState = "queued" | "running" | "completed" | "failed" | "stopped";
export type AiChatTaskOccurrence = {
  id: string;
  shortId: string;
  taskId: string;
  scheduledFor: string;
  trigger: "scheduled" | "manual";
  state: AiChatTaskOccurrenceState;
  turnId: string | null;
  error: string | null;
  resultText: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type TaskRow = {
  title: string | null;
  locale: string | null;
  reason_code: ChatTaskReasonCode | null;
  reason_at: Date | string | null;
  id: string;
  short_id: string;
  conversation_id: string;
  conversation_short_id: string;
  conversation_title: string;
  sponsor_user_id: string;
  mandate_id: string | null;
  mandate_revision: number | bigint | null;
  mandate_policy?: unknown;
  prompt: string;
  schedule_kind: "once" | "cron";
  run_at: Date | string | null;
  cron: string | null;
  timezone: string;
  state: AiChatTaskState;
  revision: number | bigint;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export class AiChatTaskIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different task input");
    this.name = "AiChatTaskIdempotencyConflictError";
  }
}

class AiChatTaskCreateRace extends Error {}
export class AiChatTaskAuthorityError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
const log = logger("ai:chat-tasks");

type OccurrenceRow = {
  id: string;
  short_id: string;
  task_id: string;
  scheduled_for: Date | string;
  trigger: "scheduled" | "manual";
  state: AiChatTaskOccurrenceState;
  turn_id: string | null;
  error: string | null;
  result_text?: string | null;
  request_key?: string;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const nullableIso = (value: Date | string | null): string | null => (value === null ? null : iso(value));
const taskIdempotencyKey = (key: string): string => `task.create:${key}`;
const chatTaskMandatePolicy = (grants: TaskGrant[]): MandatePolicyV1 => ({
  version: 1,
  apps: [...new Set(grants.map((grant) => ("appId" in grant ? grant.appId : "assistant")))],
  operations: [
    ...new Set(
      grants.flatMap((grant) =>
        !("appId" in grant)
          ? [`runtime.${grant.kind}`]
          : grant.kind === "query"
            ? [`capability.query:${grant.capabilityId}`]
            : [`capability.action.review:${grant.capabilityId}`, `capability.action.run:${grant.capabilityId}`],
      ),
    ),
  ],
  actions: grants.length ? "preapproved" : "deny",
  grants,
});
const validateTaskGrants = async (input: unknown): Promise<TaskGrant[]> => {
  const grants = TaskGrantsSchema.parse(input);
  for (const grant of grants) {
    if (!("appId" in grant)) continue;
    const entry = await getCapability(grant.appId);
    const operation = (grant.kind === "query" ? entry?.manifest.queries : entry?.manifest.actions)?.find(
      (item) => item.localId === grant.capabilityId,
    );
    if (!operation) throw new Error(`Capability unavailable: ${grant.appId}.${grant.capabilityId}`);
    if (grant.kind === "action" && (!("approval" in operation) || (operation.approval !== "none" && operation.approval !== "rememberable")))
      throw new Error(`Capability always requires interactive approval: ${grant.appId}.${grant.capabilityId}`);
    const properties = operation.inputSchema.properties ?? {};
    for (const key of Object.keys(grant.fixedInput))
      if (!Object.hasOwn(properties, key)) throw new Error(`Unknown fixed input ${key} for ${grant.appId}.${grant.capabilityId}`);
  }
  return grants;
};
const mandateAuthority = (userId: string) => ({ kind: "interactive" as const, userId });
const mandateWorkloadAuthority = { kind: "workload" as const, ownerAppId: "core" };
const mandateError = (operation: string, result: { ok: false; error: { message: string } }): Error =>
  new AiChatTaskAuthorityError(`Could not ${operation} scheduled task mandate: ${result.error.message}`);
const isChatTaskMandatePolicy = (policy: MandatePolicyV1): boolean => policy.grants !== undefined;
const mandateRevision = async (
  task: { mandate_id: string; mandate_revision: number | bigint },
  state: "active" | "paused",
  userId: string,
  db: SQL,
): Promise<number> => {
  const input = {
    mandateId: task.mandate_id,
    expectedRevision: Number(task.mandate_revision),
    authority: mandateAuthority(userId),
  };
  const result = state === "active" ? await resumeMandate(input, { db }) : await pauseMandate(input, { db });
  if (!result.ok) throw mandateError(state === "active" ? "resume" : "pause", result);
  return result.data.revision;
};
const requireTaskMandate = (
  task: Pick<TaskRow, "mandate_id" | "mandate_revision">,
): { mandate_id: string; mandate_revision: number | bigint } => {
  if (!task.mandate_id || task.mandate_revision === null)
    throw new AiChatTaskAuthorityError("Scheduled task mandate is unavailable; recreate the task");
  return { mandate_id: task.mandate_id, mandate_revision: task.mandate_revision };
};
type TaskMandateRow = {
  id: string;
  revision: number | bigint;
  state: Mandate["state"];
  subject_kind: string;
  subject_user_id: string | null;
  owner_app_id: string;
  workload_type: string;
  workload_id: string;
  confirmed_at: Date | string | null;
  unexpired: boolean;
  policy: unknown;
};
const loadTaskMandate = async (task: TaskRow, db: SQL): Promise<TaskMandateRow | null> => {
  if (!task.mandate_id) return null;
  const [mandate] = await db<TaskMandateRow[]>`
    SELECT id, revision, state, subject_kind, subject_user_id, owner_app_id, workload_type, workload_id,
      confirmed_at, (expires_at IS NULL OR expires_at > now()) AS unexpired, policy
    FROM auth.mandates WHERE id = ${task.mandate_id}::uuid
    FOR UPDATE
  `;
  return mandate ?? null;
};
const taskMandateMatches = (task: TaskRow, mandate: TaskMandateRow): boolean =>
  mandate.subject_kind === "user" &&
  mandate.subject_user_id === task.sponsor_user_id &&
  mandate.owner_app_id === "core" &&
  mandate.workload_type === "ai.chat-task" &&
  mandate.workload_id === task.id;
const taskMandatePolicy = (mandate: TaskMandateRow): MandatePolicyV1 | null => {
  try {
    const policy = MandatePolicyV1Schema.safeParse(parsePgJsonValue(mandate.policy));
    return policy.success ? policy.data : null;
  } catch {
    return null;
  }
};
const stopTaskAdmission = async (
  task: TaskRow,
  code: ChatTaskReasonCode,
  reason: string | null,
  db: SQL,
  appLocale: string | undefined,
  pausedMandateRevision?: number | null,
): Promise<null> => {
  const state = chatTaskReasonState(code);
  const [stopped] = await db<TaskRow[]>`
    UPDATE ai.chat_tasks
    SET state = ${state}, last_error = ${reason}, reason_code = ${code}, reason_at = now(),
        mandate_revision = COALESCE(${pausedMandateRevision ?? null}::bigint, mandate_revision),
        revision = revision + 1, updated_at = now()
    WHERE id = ${task.id}::uuid AND state = ${task.state} RETURNING *
  `;
  if (state === "needs_attention" && reason) {
    const occurrences = await db<{ id: string }[]>`
      UPDATE ai.chat_task_occurrences SET state = 'failed', error = ${reason}, completed_at = now()
      WHERE task_id = ${task.id}::uuid AND state = 'queued' RETURNING id
    `;
    if (!occurrences.length) {
      // Reconciliation can detect revoked authority before the next occurrence exists.
      const failed = await withAiShortIdForDb(
        db,
        "ai_chat_task_occurrences_short_id_unique",
        (attempt, shortId) => attempt<{ id: string }[]>`
        INSERT INTO ai.chat_task_occurrences(short_id, task_id, scheduled_for, trigger, request_key, task_revision, state, error, completed_at)
        VALUES (${shortId}, ${task.id}::uuid, now(), 'scheduled', ${`authority:${task.id}:${task.revision}`}, ${task.revision}, 'failed', ${reason}, now())
        ON CONFLICT DO NOTHING RETURNING id
      `,
      );
      occurrences.push(...failed);
    }
    for (const occurrence of occurrences) {
      const taskReason = { code, at: iso(stopped!.reason_at!) };
      await deliverOccurrenceResult(db, task, occurrence.id, reasonSentence(task, taskReason, appLocale), {
        reason: taskReason,
        reasonOnly: true,
      });
    }
  }
  return null;
};
/** The caller holds the task lock; mandate and sponsor locks remain held until turn admission commits. */
const prepareTaskForExecution = async (input: TaskRow, db: SQL, appLocale: string | undefined): Promise<TaskRow | null> => {
  if (input.state !== "active") return null;
  const task = input;
  const mandate = await loadTaskMandate(task, db);
  const policy = mandate ? taskMandatePolicy(mandate) : null;
  const [sponsor] = await db<{ id: string }[]>`
    SELECT id FROM auth.users WHERE id = ${task.sponsor_user_id}::uuid
      AND (account_expires IS NULL OR account_expires > now()) FOR SHARE`;
  const [conversation] = await db<{ archived_at: Date | null; created_by_user_id: string }[]>`
    SELECT archived_at, created_by_user_id FROM ai.conversations WHERE id = ${task.conversation_id}::uuid FOR UPDATE`;
  if (!sponsor)
    return stopTaskAdmission(
      task,
      "owner_inactive",
      "Scheduled task sponsor is unavailable",
      db,
      appLocale,
      await pauseTerminalTaskMandate(task, db),
    );
  const archived = () =>
    pauseTerminalTaskMandate(task, db).then((revision) =>
      stopTaskAdmission(task, "chat_archived", "Scheduled task chat is archived or unavailable", db, appLocale, revision),
    );
  if (!conversation) return archived();
  // Authority comes before the archive: a stop or change of what the routine may do must not turn into an archive
  // pause that restoring the chat would quietly undo.
  if (
    conversation.created_by_user_id !== task.sponsor_user_id ||
    !mandate ||
    !taskMandateMatches(task, mandate) ||
    !mandate.confirmed_at ||
    !mandate.unexpired ||
    !policy ||
    !isChatTaskMandatePolicy(policy) ||
    mandate.state === "revoked"
  ) {
    return stopTaskAdmission(task, "rights_changed", "Scheduled task mandate or sponsor is unavailable", db, appLocale);
  }
  if (mandate.state === "paused") return stopTaskAdmission(task, "paused", null, db, appLocale, Number(mandate.revision));
  if (task.mandate_revision === null || Number(task.mandate_revision) !== Number(mandate.revision)) {
    return stopTaskAdmission(task, "rights_changed", "Scheduled task mandate revision changed", db, appLocale);
  }
  if (conversation.archived_at) return archived();
  return task;
};
/** Terminal accounting may narrow existing authority, but must never create or resume it. */
const pauseTerminalTaskMandate = async (task: TaskRow, db: SQL): Promise<number | null> => {
  const mandate = await loadTaskMandate(task, db);
  if (!mandate || !taskMandateMatches(task, mandate)) return task.mandate_revision === null ? null : Number(task.mandate_revision);
  if (mandate.state !== "active" || !taskMandatePolicy(mandate)) return Number(mandate.revision);
  const paused = await pauseMandate(
    { mandateId: mandate.id, expectedRevision: Number(mandate.revision), authority: mandateWorkloadAuthority },
    { db },
  );
  if (!paused.ok) throw mandateError("pause", paused);
  return paused.data.revision;
};
const taskFingerprint = (input: {
  chatId: string;
  prompt: string;
  title?: string;
  schedule: AiChatTaskSchedule;
  timezone: string;
  grants?: TaskGrant[];
}): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      // Without a title the hash stays as before titles existed, so earlier idempotency keys still replay.
      JSON.stringify([
        input.chatId,
        input.prompt.trim(),
        input.schedule,
        input.timezone,
        input.grants ?? [],
        ...(input.title?.trim() ? [input.title.trim()] : []),
      ]),
    )
    .digest("hex");
const taskSelect = () => sql`
  SELECT task.*, (SELECT policy FROM auth.mandates WHERE id = task.mandate_id) AS mandate_policy, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title
  FROM ai.chat_tasks task
  JOIN ai.conversations conversation ON conversation.id = task.conversation_id
`;

const taskGrants = (row: TaskRow): TaskGrant[] => {
  try {
    const policy = MandatePolicyV1Schema.safeParse(parsePgJsonValue(row.mandate_policy));
    return policy.success ? (policy.data.grants ?? []) : [];
  } catch {
    return [];
  }
};
const toTask = (row: TaskRow): AiChatTask => ({
  title: row.title,
  name: chatTaskName({ title: row.title, chatTitle: row.conversation_title, prompt: row.prompt }),
  locale: row.locale,
  reasonCode: row.reason_code,
  reasonAt: nullableIso(row.reason_at),
  id: row.id,
  shortId: row.short_id,
  chatId: row.conversation_short_id,
  chatTitle: row.conversation_title,
  conversationId: row.conversation_id,
  sponsorUserId: row.sponsor_user_id,
  mandateId: row.mandate_id,
  mandateRevision: row.mandate_revision === null ? null : Number(row.mandate_revision),
  grants: taskGrants(row),
  prompt: row.prompt,
  schedule: row.schedule_kind === "once" ? { kind: "once", runAt: iso(row.run_at!) } : { kind: "cron", cron: row.cron! },
  timezone: row.timezone,
  state: row.state,
  revision: Number(row.revision),
  lastError: row.last_error,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toOccurrence = (row: OccurrenceRow): AiChatTaskOccurrence => ({
  id: row.id,
  shortId: row.short_id,
  taskId: row.task_id,
  scheduledFor: iso(row.scheduled_for),
  trigger: row.trigger,
  state: row.state,
  turnId: row.turn_id,
  error: row.error,
  resultText: row.result_text ?? null,
  createdAt: iso(row.created_at),
  startedAt: nullableIso(row.started_at),
  completedAt: nullableIso(row.completed_at),
});

const prepareTaskById = (taskId: string): Promise<AiChatTask | null> =>
  beginWithAppLocale(async (tx, appLocale) => {
    const [task] = await tx<TaskRow[]>`
      ${taskSelect()}
      WHERE task.id = ${taskId}::uuid
      FOR UPDATE OF task
    `;
    const prepared = task ? await prepareTaskForExecution(task, tx, appLocale) : null;
    return prepared ? toTask(prepared) : null;
  });
const loadOccurrenceTask = async (occurrenceId: string, db: SQL): Promise<TaskRow | null> => {
  const [task] = await db<TaskRow[]>`
    ${taskSelect()}
    WHERE EXISTS (
      SELECT 1 FROM ai.chat_task_occurrences occurrence
      WHERE occurrence.id = ${occurrenceId}::uuid AND occurrence.task_id = task.id
    )
    FOR UPDATE OF task
  `;
  return task ?? null;
};
const loadTurnTask = async (turnId: string, db: SQL): Promise<TaskRow | null> => {
  const [task] = await db<TaskRow[]>`
    ${taskSelect()}
    WHERE EXISTS (
      SELECT 1 FROM ai.chat_task_occurrences occurrence
      WHERE occurrence.turn_id = ${turnId}::uuid AND occurrence.task_id = task.id
    )
    FOR UPDATE OF task
  `;
  return task ?? null;
};

/**
 * A transaction that may word a routine's reason or stop line. The app locale is read first: on a cache miss the
 * settings read takes another pooled connection, which must never wait inside a transaction holding task locks.
 */
const beginWithAppLocale = async <T>(run: (tx: SQL, appLocale: string | undefined) => Promise<T>): Promise<T> => {
  const appLocale = await coreSettings.get<string>("app.locale");
  return sql.begin((tx) => run(tx, appLocale));
};

/** Called in the occurrence terminal transition transaction, so delivery is exactly once. */
const reasonSentence = (task: TaskRow, reason: ChatTaskReason, appLocale: string | undefined): string =>
  chatTaskReasonSentence(reason, { locale: chatTaskLocale(task.locale, appLocale), timeZone: task.timezone });

const deliverOccurrenceResult = async (
  db: SQL,
  task: TaskRow,
  occurrenceId: string,
  resultText: string,
  extra: Pick<NonNullable<NonNullable<AiStoredMessage["meta"]>["scheduledTask"]>, "reason" | "reasonOnly" | "stop"> = {},
): Promise<void> => {
  const [occurrence] = await db<OccurrenceRow[]>`
    UPDATE ai.chat_task_occurrences SET result_text = ${resultText}, delivered_at = now()
    WHERE id = ${occurrenceId}::uuid AND delivered_at IS NULL RETURNING *
  `;
  if (!occurrence) return;
  const [destination] = await db<{ id: string }[]>`
    SELECT id FROM ai.conversations WHERE id = ${task.conversation_id}::uuid AND archived_at IS NULL FOR UPDATE
  `;
  if (!destination) return;
  const message: Message = { role: "assistant", content: [{ type: "text", text: resultText }] };
  const meta = {
    scheduledTask: {
      taskId: task.short_id,
      occurrenceId: occurrence.short_id,
      scheduledFor: iso(occurrence.scheduled_for),
      trigger: occurrence.trigger,
      ...extra,
    },
  };
  await withAiShortIdForDb(
    db,
    "idx_ai_messages_conversation_short_id",
    (attempt, shortId) => attempt`
    INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, search_text, meta)
    VALUES (${shortId}, ${task.conversation_id}::uuid,
      (SELECT COALESCE(MAX(seq),0)+1 FROM ai.messages WHERE conversation_id = ${task.conversation_id}::uuid),
      'message', 'assistant', ${JSON.stringify(message)}::text::jsonb, ${resultText}, ${JSON.stringify(meta)}::text::jsonb)
  `,
  );
  await db`UPDATE ai.conversations SET done = NULL, last_used_at = now(), updated_at = now(), background_received_at = now() WHERE id = ${task.conversation_id}::uuid`;
};

type StopCause = "paused" | "deleted";
const withTaskAbortTransaction = async <T>(
  run: (tx: SQL, stop: (task: TaskRow, cause: StopCause) => Promise<void>) => Promise<T>,
): Promise<T> => {
  const aborts: Array<{
    input: { conversationId: string; turnId: string };
    request: Awaited<ReturnType<typeof aiConversations.requestTurnAbort>>;
  }> = [];
  const result = await beginWithAppLocale(async (tx, appLocale) =>
    run(tx, async (task, cause) => {
      const turns = await tx<{ turn_id: string; scheduled_for: Date | string; trigger: "scheduled" | "manual" }[]>`
        SELECT turn_id, scheduled_for, trigger FROM ai.chat_task_occurrences
      WHERE task_id = ${task.id}::uuid AND state = 'running' AND turn_id IS NOT NULL`;
      for (const turn of turns) {
        const input = { conversationId: task.conversation_id, turnId: turn.turn_id };
        // Keep the run's delivery coordinates even when its task/occurrence is about to cascade away.
        const locale = chatTaskLocale(task.locale, appLocale);
        await tx`UPDATE ai.turns SET run_config = jsonb_set(
          jsonb_set(run_config, '{locale}', to_jsonb(COALESCE(run_config->>'locale', ${locale}))),
          '{background}', jsonb_build_object('scheduledFor', ${iso(turn.scheduled_for)}::text,
            'trigger', ${turn.trigger}::text, 'timezone', ${task.timezone}::text) || (run_config->'background'))
          WHERE id = ${turn.turn_id}::uuid AND run_config ? 'background'`;
        const request = await aiConversations.requestTurnAbort(
          { ...input, reason: cause === "paused" ? "routine_paused" : "routine_deleted" },
          { db: tx },
        );
        aborts.push({ input, request });
      }
    }),
  );
  for (const { input, request } of aborts) {
    await finishAiTurnAbort(input, request);
    if (request.found && request.ownerless) await aiChatTasks.finalizeTurn({ turnId: input.turnId, status: "aborted" });
  }
  return result;
};

type StoppedTurn = { id: string; conversation_id: string; cancellation_reason: string | null; run_config: AiChatTurnRunConfig };
/** The turn lock and persisted receipt survive deletion of the task and its occurrences. */
/** Returns the stop line once; `null` when another finalization already claimed it. */
const deliverStoppedTurn = async (
  db: SQL,
  turn: StoppedTurn,
  cause: StopCause,
  task: TaskRow | null,
  appLocale: string | undefined,
): Promise<string | null> => {
  const config = turn.run_config;
  if (!config.background) return null;
  // Chat before turn, the order archiving locks them in, so the two never wait on each other.
  const [conversation] = await db<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM ai.conversations WHERE id = ${turn.conversation_id}::uuid FOR UPDATE`;
  const [claimed] = await db`UPDATE ai.turns SET run_config = jsonb_set(run_config, '{background,stopDeliveredAt}', to_jsonb(now()::text))
    WHERE id = ${turn.id}::uuid AND run_config #>> '{background,stopDeliveredAt}' IS NULL RETURNING id`;
  if (!claimed) return null;
  const locale = chatTaskLocale(config.locale ?? task?.locale, appLocale);
  const messages = await db<{ seq: number; message: Message; meta: AiStoredMessage["meta"] }[]>`
    SELECT seq, message, meta FROM ai.task_messages WHERE loop_id = ${turn.id} ORDER BY seq`;
  const done = buildBlocksFromMessages(messages).flatMap((block) => {
    if (block.kind !== "tool" || block.status !== "completed" || block.isError) return [];
    // Web reads have chat wording too, but do not change anything for a stop receipt.
    if (block.name === "web_extract") return [];
    if (block.result && typeof block.result === "object" && "ok" in block.result && block.result.ok === false) return [];
    const wording = toolWording(block, locale);
    if (!wording) return [];
    // An Action without a done sentence still changed something; its title names it instead of dropping it.
    return [toolOutcome(block, "done", locale, config.background?.timezone ?? task?.timezone ?? "UTC") ?? wording.title];
  });
  const text = chatTaskStopSentence(done, locale);
  if (!conversation || conversation.archived_at) return text;
  const scheduledTask = {
    taskId: config.background.taskId,
    occurrenceId: config.background.occurrenceId,
    scheduledFor: config.background.scheduledFor ?? "",
    trigger: config.background.trigger ?? "scheduled",
    stop: { cause, done },
  };
  const message: Message = { role: "assistant", content: [{ type: "text", text }] };
  await withAiShortIdForDb(
    db,
    "idx_ai_messages_conversation_short_id",
    (attempt, shortId) => attempt`
    INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, search_text, meta)
    VALUES (${shortId}, ${turn.conversation_id}::uuid,
      (SELECT COALESCE(MAX(seq),0)+1 FROM ai.messages WHERE conversation_id = ${turn.conversation_id}::uuid),
      'message', 'assistant', ${JSON.stringify(message)}::text::jsonb, ${text}, ${JSON.stringify({ scheduledTask })}::text::jsonb)`,
  );
  await db`UPDATE ai.conversations SET done = NULL, last_used_at = now(), updated_at = now(), background_received_at = now()
    WHERE id = ${turn.conversation_id}::uuid`;
  return text;
};

export const aiChatTasks = {
  listActivities: async (input: { userId: string; limit?: number; offset?: number }) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const rows = await sql<(OccurrenceRow & { unread: boolean })[]>`
      SELECT occurrence.*, (occurrence.delivered_at > COALESCE(conversation.last_viewed_at, '-infinity')) AS unread
      FROM ai.chat_task_occurrences occurrence
      JOIN ai.chat_tasks task ON task.id = occurrence.task_id
      JOIN ai.conversations conversation ON conversation.id = task.conversation_id
      WHERE task.sponsor_user_id = ${input.userId}::uuid AND conversation.created_by_user_id = ${input.userId}::uuid
        AND conversation.archived_at IS NULL
      ORDER BY occurrence.created_at DESC, occurrence.id DESC LIMIT ${limit + 1} OFFSET ${Math.max(input.offset ?? 0, 0)}
    `;
    const page = rows.slice(0, limit);
    if (!page.length) return { items: [], hasMore: false };
    const tasks = await sql<TaskRow[]>`${taskSelect()} WHERE task.id IN
      (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify([...new Set(page.map((row) => row.task_id))])}::text::jsonb))`;
    const byId = new Map(tasks.map((row) => [row.id, toTask(row)]));
    return {
      items: page.flatMap((row) => {
        const task = byId.get(row.task_id);
        return task
          ? [
              {
                task,
                occurrence: toOccurrence(row),
                chatTitle: task.chatTitle,
                unread: Boolean(row.unread),
              },
            ]
          : [];
      }),
      hasMore: rows.length > limit,
    };
  },

  getOccurrenceDetail: async (input: { userId: string; taskId: string; occurrenceId: string }) => {
    const task = await aiChatTasks.get({ userId: input.userId, taskId: input.taskId });
    if (!task) return null;
    const [row] = await sql<
      OccurrenceRow[]
    >`SELECT * FROM ai.chat_task_occurrences WHERE task_id = ${task.id}::uuid AND short_id = ${input.occurrenceId}`;
    if (!row) return null;
    const messages = row.turn_id
      ? await aiConversations.listTurnMessages({ conversationId: task.conversationId, loopId: row.turn_id, includeCompacted: true })
      : [];
    return { task, occurrence: toOccurrence(row), messages };
  },

  validateGrants: validateTaskGrants,
  authorizeRuntime: async (input: {
    mandate: { id: string; revision: number };
    kind: "http" | "database";
    input: unknown;
  }): Promise<void> => {
    const result = await validateMandateIssueAuthority({
      mandateId: input.mandate.id,
      expectedRevision: input.mandate.revision,
      ownerAppId: "core",
      targetAppId: "assistant",
      operation: `runtime.${input.kind}`,
      input: input.input,
    });
    if (!result.ok)
      throw new AiChatTaskAuthorityError(
        `Background ${input.kind} access denied: ${result.error.message}. Update this task's grants in the normal chat.`,
      );
  },
  authorizeCapability: async (input: {
    mandate: { id: string; revision: number };
    appId: string;
    capabilityId: string;
    kind: "query" | "action";
    input: unknown;
    approval?: "none" | "rememberable" | "always";
  }): Promise<void> => {
    const result = await validateMandateIssueAuthority({
      mandateId: input.mandate.id,
      expectedRevision: input.mandate.revision,
      ownerAppId: "core",
      targetAppId: input.appId,
      operation: `capability.${input.kind === "query" ? "query" : "action.run"}:${input.capabilityId}`,
      input: input.input,
      capabilityApproval: input.approval,
    });
    if (!result.ok) {
      const policyDenied = result.error.code === "FORBIDDEN" && result.error.message === MANDATE_POLICY_DENIED_MESSAGE;
      throw new AiChatTaskAuthorityError(
        policyDenied
          ? `This task's grants do not allow ${input.appId}.${input.capabilityId} with these inputs; continue with the granted tools or explain what is missing.`
          : `Background task cannot call ${input.appId}.${input.capabilityId}: ${result.error.message}. Check the task grants and fixed inputs in the normal chat; this run cannot expand them.`,
        policyDenied ? "MANDATE_POLICY_DENIED" : result.error.code,
      );
    }
  },
  list: async (input: {
    userId: string;
    chatId?: string;
    state?: AiChatTaskState;
    limit?: number;
    offset?: number;
  }): Promise<AiChatTask[]> => {
    const rows = await sql<TaskRow[]>`
      ${taskSelect()}
      WHERE task.sponsor_user_id = ${input.userId}::uuid
        AND (${input.chatId ?? null}::text IS NULL OR conversation.short_id = ${input.chatId ?? null})
        AND (${input.state ?? null}::text IS NULL OR task.state = ${input.state ?? null})
      ORDER BY task.created_at DESC, task.id DESC
      LIMIT ${Math.min(Math.max(input.limit ?? 50, 1), 100)}
      OFFSET ${Math.max(input.offset ?? 0, 0)}
    `;
    return rows.map(toTask);
  },

  get: async (input: { userId: string; taskId: string }): Promise<AiChatTask | null> => {
    const rows = await sql<TaskRow[]>`
      ${taskSelect()}
      WHERE task.sponsor_user_id = ${input.userId}::uuid
        AND task.short_id = ${input.taskId}
      LIMIT 1
    `;
    return rows[0] ? toTask(rows[0]) : null;
  },

  create: async (input: {
    userId: string;
    chatId: string;
    prompt: string;
    title?: string;
    locale?: string;
    schedule: AiChatTaskSchedule;
    timezone: string;
    grants?: TaskGrant[];
    idempotencyKey?: string;
    idempotencyFingerprint?: string;
  }): Promise<AiChatTask | null> => {
    const scopedKey = input.idempotencyKey ? taskIdempotencyKey(input.idempotencyKey) : null;
    const fingerprint = scopedKey ? (input.idempotencyFingerprint ?? taskFingerprint(input)) : null;
    if (input.idempotencyKey) {
      const existing = await sql<(TaskRow & { idempotency_fingerprint: string | null })[]>`
        ${taskSelect()}
        WHERE task.idempotency_key = ${scopedKey}
          AND task.sponsor_user_id = ${input.userId}::uuid
        LIMIT 1
      `;
      if (existing[0]) {
        if (existing[0].idempotency_fingerprint !== fingerprint) throw new AiChatTaskIdempotencyConflictError();
        return toTask(existing[0]);
      }
    }
    const grants = await validateTaskGrants(input.grants ?? []);
    let rows: TaskRow[];
    try {
      rows = await sql.begin(async (tx) => {
        const conversations = await tx<{ id: string; title: string }[]>`
        SELECT id, title FROM ai.conversations
        WHERE short_id = ${input.chatId}
          AND created_by_user_id = ${input.userId}::uuid
          AND archived_at IS NULL
        LIMIT 1
      `;
        const conversation = conversations[0];
        if (!conversation) return [];
        const taskId = crypto.randomUUID();
        const mandate = await createMandate(
          {
            authority: mandateAuthority(input.userId),
            subject: { type: "user", id: input.userId },
            ownerAppId: "core",
            workloadType: "ai.chat-task",
            workloadId: taskId,
            policy: chatTaskMandatePolicy(grants),
          },
          { db: tx },
        );
        if (!mandate.ok) throw mandateError("create", mandate);
        const inserted = await withAiShortIdForDb(
          tx,
          "ai_chat_tasks_short_id_unique",
          (attempt, shortId) => attempt<TaskRow[]>`
          INSERT INTO ai.chat_tasks (
            id, short_id, conversation_id, sponsor_user_id, prompt, title, locale, schedule_kind, run_at, cron, timezone,
            mandate_id, mandate_revision, idempotency_key, idempotency_fingerprint
          )
          VALUES (
            ${taskId}::uuid, ${shortId}, ${conversation.id}::uuid, ${input.userId}::uuid, ${input.prompt.trim()}, ${input.title?.trim() ?? null}, ${canonicalLocale(input.locale) ?? null}, ${input.schedule.kind},
            ${input.schedule.kind === "once" ? input.schedule.runAt : null}::timestamptz,
            ${input.schedule.kind === "cron" ? input.schedule.cron : null}, ${input.timezone},
            ${mandate.data.id}::uuid, ${mandate.data.revision}, ${scopedKey}, ${fingerprint}
          )
          ON CONFLICT (sponsor_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
          RETURNING *, ${input.chatId} AS conversation_short_id, ${conversation.title} AS conversation_title
        `,
        );
        const task = inserted[0];
        if (!task) throw new AiChatTaskCreateRace();
        task.mandate_policy = mandate.data.policy;
        return inserted;
      });
    } catch (error) {
      if (!(error instanceof AiChatTaskCreateRace)) throw error;
      rows = [];
    }
    if (rows[0]) return toTask(rows[0]);
    if (!input.idempotencyKey) return null;
    const existing = await sql<(TaskRow & { idempotency_fingerprint: string | null })[]>`
      ${taskSelect()}
      WHERE task.idempotency_key = ${scopedKey}
        AND task.sponsor_user_id = ${input.userId}::uuid
      LIMIT 1
    `;
    if (!existing[0]) return null;
    if (existing[0].idempotency_fingerprint !== fingerprint) throw new AiChatTaskIdempotencyConflictError();
    return toTask(existing[0]);
  },

  getCreateByIdempotency: async (input: {
    userId: string;
    idempotencyKey: string;
    idempotencyFingerprint: string;
  }): Promise<AiChatTask | null> => {
    const rows = await sql<(TaskRow & { idempotency_fingerprint: string | null })[]>`
      ${taskSelect()}
      WHERE task.idempotency_key = ${taskIdempotencyKey(input.idempotencyKey)}
        AND task.sponsor_user_id = ${input.userId}::uuid
      LIMIT 1
    `;
    if (!rows[0]) return null;
    if (rows[0].idempotency_fingerprint !== input.idempotencyFingerprint) throw new AiChatTaskIdempotencyConflictError();
    return toTask(rows[0]);
  },

  update: async (input: {
    userId: string;
    taskId: string;
    prompt?: string;
    title?: string;
    grants?: TaskGrant[];
    schedule?: AiChatTaskSchedule;
    timezone?: string;
  }): Promise<AiChatTask | null> =>
    beginWithAppLocale(async (tx, appLocale) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect()}
        WHERE task.sponsor_user_id = ${input.userId}::uuid
          AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return null;
      requireTaskMandate(current);
      const wasActive = current.state === "active";
      const authorityStopped = wasActive && !(await prepareTaskForExecution(current, tx, appLocale));
      if (authorityStopped) {
        [current] = await tx<TaskRow[]>`${taskSelect()} WHERE task.id = ${current.id}::uuid`;
        if (!current) return null;
      }
      const nextTimezone = input.timezone ?? current.timezone;
      const scheduleChanged = input.schedule
        ? input.schedule.kind !== current.schedule_kind ||
          (input.schedule.kind === "once" ? iso(input.schedule.runAt) !== iso(current.run_at!) : input.schedule.cron !== current.cron) ||
          nextTimezone !== current.timezone
        : false;
      const promptChanged = input.prompt !== undefined && input.prompt.trim() !== current.prompt;
      const grants = input.grants === undefined ? undefined : await validateTaskGrants(input.grants);
      let updatedMandateRevision = Number(current.mandate_revision);
      if (grants !== undefined) {
        const mandate = await loadTaskMandate(current, tx);
        if (!mandate || !taskMandateMatches(current, mandate)) throw new AiChatTaskAuthorityError("Scheduled task mandate is unavailable");
        const updated = await updateMandatePolicy(
          {
            mandateId: mandate.id,
            expectedRevision: Number(mandate.revision),
            authority: mandateAuthority(input.userId),
            policy: chatTaskMandatePolicy(grants),
          },
          { db: tx },
        );
        if (!updated.ok) throw mandateError("update", updated);
        updatedMandateRevision = updated.data.revision;
      }
      const titleChanged = input.title !== undefined && input.title.trim() !== current.title;
      if (!promptChanged && !scheduleChanged && grants === undefined) {
        if (!titleChanged) return toTask(current);
        // A new name changes nothing about when or how the routine runs: state, reason and revision stay.
        const [renamed] = await tx<TaskRow[]>`
          UPDATE ai.chat_tasks task SET title = ${input.title!.trim()}, updated_at = now()
          FROM ai.conversations conversation
          WHERE conversation.id = task.conversation_id AND task.id = ${current.id}::uuid
          RETURNING task.*, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title`;
        return renamed ? toTask({ ...renamed, mandate_policy: current.mandate_policy }) : null;
      }
      await tx`
        UPDATE ai.chat_tasks task
        SET title = ${input.title?.trim() ?? current.title}, mandate_revision = ${updatedMandateRevision}, prompt = ${input.prompt?.trim() ?? current.prompt},
            schedule_kind = ${input.schedule?.kind ?? current.schedule_kind},
            run_at = ${input.schedule ? (input.schedule.kind === "once" ? input.schedule.runAt : null) : current.run_at}::timestamptz,
            cron = ${input.schedule ? (input.schedule.kind === "cron" ? input.schedule.cron : null) : current.cron},
            timezone = ${input.timezone ?? current.timezone},
            state = CASE
              WHEN ${authorityStopped} THEN task.state
              WHEN task.state = 'paused' THEN ${chatTaskReasonState("paused")}
              WHEN task.state = 'completed' AND ${scheduleChanged} = false THEN 'completed'
              ELSE 'active'
            END,
            last_error = CASE
              WHEN ${authorityStopped} OR task.state = 'paused' OR (task.state = 'completed' AND ${scheduleChanged} = false)
                THEN task.last_error
              ELSE NULL
            END,
            reason_code = CASE WHEN ${authorityStopped} OR task.state = 'paused' OR (task.state = 'completed' AND ${scheduleChanged} = false) THEN task.reason_code ELSE NULL END,
            reason_at = CASE WHEN ${authorityStopped} OR task.state = 'paused' OR (task.state = 'completed' AND ${scheduleChanged} = false) THEN task.reason_at ELSE NULL END,
            revision = task.revision + 1, updated_at = now()
        WHERE id = ${current.id}::uuid
      `;
      if (scheduleChanged) {
        await tx`
          UPDATE ai.chat_task_occurrences
          SET state = 'failed', error = 'Task schedule changed', completed_at = now()
          WHERE task_id = ${current.id}::uuid AND state = 'queued'
        `;
      }
      const updated = await tx<TaskRow[]>`${taskSelect()} WHERE task.id = ${current.id}::uuid`;
      const next = updated[0]!;
      if (next.state === "active" && !wasActive) {
        const revision = await mandateRevision(requireTaskMandate(next), "active", input.userId, tx);
        if (revision !== Number(next.mandate_revision)) {
          next.mandate_revision = revision;
          await tx`UPDATE ai.chat_tasks SET mandate_revision = ${revision} WHERE id = ${next.id}::uuid`;
        }
      }
      return toTask(next);
    }),

  pauseForArchivedChat: async (input: { conversationId: string; userId?: string }): Promise<void> => {
    await beginWithAppLocale(async (tx, appLocale) => {
      const tasks = await tx<TaskRow[]>`${taskSelect()}
        WHERE task.conversation_id = ${input.conversationId}::uuid AND task.state = 'active'
          AND (${input.userId ?? null}::uuid IS NULL OR task.sponsor_user_id = ${input.userId ?? null}::uuid)
        ORDER BY task.id FOR UPDATE OF task`;
      if (!tasks.length) return;
      // Locks in admission order (tasks, then chat). A restore that committed first leaves its routines running;
      // one that comes later waits for this pause and then resumes them.
      const [archived] = await tx`SELECT 1 FROM ai.conversations WHERE id = ${input.conversationId}::uuid
        AND archived_at IS NOT NULL FOR UPDATE`;
      if (!archived) return;
      // Admission decides the reason: an archive pause only for a routine whose authority is still intact.
      for (const task of tasks) await prepareTaskForExecution(task, tx, appLocale);
    });
  },

  resumeForRestoredChat: async (input: { conversationId: string; userId?: string; resume: boolean }): Promise<void> => {
    const tasks = await sql<TaskRow[]>`${taskSelect()}
      WHERE task.conversation_id = ${input.conversationId}::uuid AND task.reason_code = 'chat_archived'
        AND (${input.userId ?? null}::uuid IS NULL OR task.sponsor_user_id = ${input.userId ?? null}::uuid)`;
    for (const task of tasks) {
      try {
        if (
          input.resume &&
          (await aiChatTasks.setState({
            userId: task.sponsor_user_id,
            taskId: task.short_id,
            state: "active",
            expectedReason: "chat_archived",
          }))
        )
          continue;
        await sql.begin(async (tx) => {
          const [current] = await tx<TaskRow[]>`${taskSelect()} WHERE task.id = ${task.id}::uuid FOR UPDATE OF task`;
          // Archived again meanwhile: the routine stays paused for that reason.
          const [restored] = await tx`SELECT 1 FROM ai.conversations WHERE id = ${input.conversationId}::uuid
            AND archived_at IS NULL FOR SHARE`;
          if (current?.reason_code === "chat_archived" && restored)
            await tx`UPDATE ai.chat_tasks SET reason_code = 'paused', updated_at = now() WHERE id = ${current.id}::uuid`;
        });
      } catch (error) {
        if (!(error instanceof AiChatTaskAuthorityError)) throw error;
        await beginWithAppLocale(async (tx, appLocale) => {
          const [current] = await tx<TaskRow[]>`${taskSelect()} WHERE task.id = ${task.id}::uuid FOR UPDATE OF task`;
          // Archived again meanwhile: the routine stays paused for that reason.
          const [restored] = await tx`SELECT 1 FROM ai.conversations WHERE id = ${input.conversationId}::uuid
            AND archived_at IS NULL FOR SHARE`;
          if (current?.reason_code === "chat_archived" && restored)
            await stopTaskAdmission(current, "rights_changed", error.message, tx, appLocale);
        });
      }
    }
  },

  /** Run before a restore: the fresh timestamp keeps the recovery backstop away from routines this restore handles. */
  markRestoreStarted: async (input: { conversationId: string; userId?: string }): Promise<void> => {
    await sql`UPDATE ai.chat_tasks SET updated_at = now()
      WHERE conversation_id = ${input.conversationId}::uuid AND reason_code = 'chat_archived'
        AND (${input.userId ?? null}::uuid IS NULL OR sponsor_user_id = ${input.userId ?? null}::uuid)`;
  },

  /**
   * Recovery backstop for a restore whose routine step failed: archive pauses of restored chats become plain pauses,
   * so they never name an archive that has ended. It never resumes; the grace leaves a restore in progress alone.
   */
  relabelRestoredArchivePauses: async (input: { olderThanMs?: number; limit?: number } = {}): Promise<number> => {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const graceSeconds = Math.max(input.olderThanMs ?? 5 * 60_000, 0) / 1000;
    return sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        SELECT task.id FROM ai.chat_tasks task
        JOIN ai.conversations conversation ON conversation.id = task.conversation_id
        WHERE task.reason_code = 'chat_archived' AND conversation.archived_at IS NULL
          AND task.updated_at < now() - make_interval(secs => ${graceSeconds}::double precision)
        ORDER BY task.id LIMIT ${limit}
        FOR UPDATE OF task SKIP LOCKED FOR SHARE OF conversation SKIP LOCKED`;
      for (const row of rows) await tx`UPDATE ai.chat_tasks SET reason_code = 'paused', updated_at = now() WHERE id = ${row.id}::uuid`;
      return rows.length;
    });
  },

  setState: async (input: {
    userId: string;
    taskId: string;
    state: "active" | "paused";
    expectedReason?: ChatTaskReasonCode;
  }): Promise<AiChatTask | null> => {
    return withTaskAbortTransaction(async (tx, stop) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect()}
        WHERE task.sponsor_user_id = ${input.userId}::uuid AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return null;
      if (input.expectedReason && current.reason_code !== input.expectedReason) return null;
      // An automatic resume continues only the authority it paused; any change since then needs a confirmation.
      if (input.expectedReason) {
        const paused = await loadTaskMandate(current, tx);
        if (!paused || current.mandate_revision === null || Number(paused.revision) !== Number(current.mandate_revision))
          throw new AiChatTaskAuthorityError("Scheduled task mandate changed while the routine was paused");
      }
      requireTaskMandate(current);
      const allowed =
        current.state === input.state ||
        (current.state === "active" && input.state === "paused") ||
        (current.state === "paused" && input.state === "active" && !chatTaskNeedsNewTime(toTask(current))) ||
        (current.state === "needs_attention" && current.schedule_kind === "cron" && input.state === "active");
      if (!allowed) return null;
      const mandate = await loadTaskMandate(current, tx);
      if (!mandate || !taskMandateMatches(current, mandate)) {
        throw new AiChatTaskAuthorityError("Scheduled task mandate is unavailable");
      }
      if (input.state === "active") {
        const [available] = await tx`SELECT sponsor.id FROM auth.users sponsor JOIN ai.conversations conversation
          ON conversation.created_by_user_id = sponsor.id WHERE sponsor.id = ${current.sponsor_user_id}::uuid
          AND conversation.id = ${current.conversation_id}::uuid AND conversation.archived_at IS NULL
          AND (sponsor.account_expires IS NULL OR sponsor.account_expires > now())
          FOR SHARE OF conversation`;
        // Held until this resume commits, so an archive waits for it and its follow-up then pauses the routine again.
        if (!available) throw new AiChatTaskAuthorityError("Scheduled task sponsor or chat is unavailable");
        const policy = taskMandatePolicy(mandate);
        if (!mandate.confirmed_at || !mandate.unexpired || !policy || !isChatTaskMandatePolicy(policy)) {
          throw new AiChatTaskAuthorityError("Scheduled task mandate cannot be resumed");
        }
      }
      const revision = await mandateRevision({ mandate_id: mandate.id, mandate_revision: mandate.revision }, input.state, input.userId, tx);
      const updated = await tx<TaskRow[]>`
        UPDATE ai.chat_tasks task
        SET state = ${input.state === "paused" ? chatTaskReasonState("paused") : "active"}, mandate_revision = ${revision},
            reason_code = ${input.state === "paused" ? "paused" : null},
            reason_at = CASE WHEN ${input.state} = 'active' THEN NULL WHEN task.reason_code = 'paused' THEN task.reason_at ELSE now() END,
            last_error = CASE WHEN task.state = ${input.state} THEN task.last_error ELSE NULL END,
            revision = CASE WHEN task.state = ${input.state} THEN task.revision ELSE task.revision + 1 END,
            updated_at = CASE WHEN task.state = ${input.state} THEN task.updated_at ELSE now() END
        FROM ai.conversations conversation
        WHERE conversation.id = task.conversation_id AND task.id = ${current.id}::uuid
        RETURNING task.*, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title
      `;
      if (input.state === "paused") await stop(current, "paused");
      return updated[0] ? toTask(updated[0]) : null;
    });
  },

  delete: async (input: { userId: string; taskId: string }): Promise<boolean> => {
    return withTaskAbortTransaction(async (tx, stop) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect()}
        WHERE task.sponsor_user_id = ${input.userId}::uuid AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return false;
      await stop(current, "deleted");
      if (!current.mandate_id && current.mandate_revision === null) {
        await tx`DELETE FROM ai.chat_tasks WHERE id = ${current.id}::uuid`;
        return true;
      }
      requireTaskMandate(current);
      const mandate = await loadTaskMandate(current, tx);
      if (!mandate || !taskMandateMatches(current, mandate)) {
        throw new AiChatTaskAuthorityError("Scheduled task mandate is unavailable");
      }
      const revoked = await revokeMandate(
        {
          mandateId: mandate.id,
          expectedRevision: Number(mandate.revision),
          authority: mandateAuthority(input.userId),
          reason: "Scheduled chat task deleted",
        },
        { db: tx },
      );
      if (!revoked.ok) throw mandateError("revoke", revoked);
      await tx`DELETE FROM ai.chat_tasks WHERE id = ${current.id}::uuid`;
      return true;
    });
  },

  listOccurrences: async (input: { userId: string; taskId: string; limit?: number }): Promise<AiChatTaskOccurrence[] | null> => {
    const task = await aiChatTasks.get(input);
    if (!task) return null;
    const rows = await sql<OccurrenceRow[]>`
      SELECT * FROM ai.chat_task_occurrences
      WHERE task_id = ${task.id}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${Math.min(Math.max(input.limit ?? 20, 1), 100)}
    `;
    return rows.map(toOccurrence);
  },

  listActiveCron: async (): Promise<AiChatTask[]> => {
    const rows = await sql<TaskRow[]>`
      ${taskSelect()}
      WHERE task.state = 'active' AND task.schedule_kind = 'cron'
    `;
    const tasks: AiChatTask[] = [];
    for (const row of rows) {
      try {
        const prepared = await prepareTaskById(row.id);
        if (prepared) tasks.push(prepared);
      } catch (error) {
        log.warn("Scheduled task reconciliation failed", { taskId: row.id, error: error instanceof Error ? error.message : String(error) });
        // Retain the registration during transient storage failures. Every run still revalidates authority.
        tasks.push(toTask(row));
      }
    }
    return tasks;
  },

  createOccurrence: async (input: {
    taskId: string;
    scheduledFor: string;
    trigger: "scheduled" | "manual";
    requestKey: string;
    expectedRevision?: number;
  }): Promise<AiChatTaskOccurrence | null> => {
    return beginWithAppLocale(async (tx, appLocale) => {
      const [current] = await tx<TaskRow[]>`${taskSelect()} WHERE task.id = ${input.taskId}::uuid FOR UPDATE OF task`;
      if (!current || !(await prepareTaskForExecution(current, tx, appLocale))) return null;
      // One occurrence per schedule; timer ticks during a run do not accumulate.
      const [inFlight] = await tx<
        OccurrenceRow[]
      >`SELECT * FROM ai.chat_task_occurrences WHERE task_id = ${input.taskId}::uuid AND state IN ('queued','running') LIMIT 1`;
      if (inFlight) return inFlight.request_key === input.requestKey ? toOccurrence(inFlight) : null;

      const rows = await withAiShortIdForDb(
        tx,
        "ai_chat_task_occurrences_short_id_unique",
        (attempt, shortId) => attempt<OccurrenceRow[]>`
      INSERT INTO ai.chat_task_occurrences (short_id, task_id, scheduled_for, trigger, request_key, task_revision)
      SELECT ${shortId}, task.id, ${input.scheduledFor}::timestamptz, ${input.trigger}, ${input.requestKey}, task.revision
      FROM ai.chat_tasks task
      WHERE task.id = ${input.taskId}::uuid AND task.state = 'active'
        AND (${input.expectedRevision ?? null}::bigint IS NULL OR task.revision = ${input.expectedRevision ?? null}::bigint)
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
      );
      if (rows[0]) return toOccurrence(rows[0]);
      const existing = await tx<OccurrenceRow[]>`
      SELECT * FROM ai.chat_task_occurrences WHERE request_key = ${input.requestKey} LIMIT 1
    `;
      if (!existing[0]) return null;
      if (existing[0].task_id !== input.taskId) throw new AiChatTaskIdempotencyConflictError();
      return toOccurrence(existing[0]);
    });
  },

  materializeDueOnce: async (limit = 100): Promise<AiChatTaskOccurrence[]> => {
    const tasks = await sql<{ id: string; run_at: Date | string; revision: number | bigint }[]>`
      SELECT task.id, task.run_at, task.revision
      FROM ai.chat_tasks task
      JOIN ai.conversations conversation ON conversation.id = task.conversation_id
      WHERE task.state = 'active' AND task.schedule_kind = 'once' AND task.run_at <= now()
      ORDER BY run_at, id
      LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `;
    const occurrences: AiChatTaskOccurrence[] = [];
    for (const task of tasks) {
      try {
        const slot = iso(task.run_at);
        const occurrence = await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: slot,
          trigger: "scheduled",
          requestKey: `once:${task.id}:${slot}`,
          expectedRevision: Number(task.revision),
        });
        if (occurrence?.state === "queued") occurrences.push(occurrence);
      } catch (error) {
        log.warn("Scheduled task materialization failed", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return occurrences;
  },

  /** Removes expired runs and their evidence, preserving current once slot rows as dedupe guards. */
  pruneExpiredRuns: async (input: { now?: Date; limit?: number } = {}): Promise<number> => {
    const cutoff = new Date((input.now ?? new Date()).getTime() - AI_CHAT_TASK_RUN_RETENTION_DAYS * 86_400_000);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    return sql.begin(async (tx) => {
      // Keep the current once slot row as a dedupe guard while its turn and transcript expire.
      const occurrences = await tx<{ id: string; turn_id: string | null; keep: boolean }[]>`
        SELECT occurrence.id, occurrence.turn_id, EXISTS (
          SELECT 1 FROM ai.chat_tasks task WHERE task.id = occurrence.task_id
            AND task.schedule_kind = 'once' AND task.run_at = occurrence.scheduled_for
        ) AS keep
        FROM ai.chat_task_occurrences occurrence
        WHERE occurrence.state IN ('completed', 'failed', 'stopped') AND occurrence.completed_at < ${cutoff}
          AND (occurrence.turn_id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM ai.chat_tasks task WHERE task.id = occurrence.task_id
              AND task.schedule_kind = 'once' AND task.run_at = occurrence.scheduled_for
          ))
          AND NOT EXISTS (
            SELECT 1 FROM ai.turns turn WHERE turn.id = occurrence.turn_id
              AND turn.status NOT IN ('completed', 'failed', 'aborted')
          )
        ORDER BY occurrence.completed_at, occurrence.id
        LIMIT ${limit}
        FOR UPDATE OF occurrence SKIP LOCKED
      `;
      if (occurrences.length > 0) {
        const occurrenceIds = toPgUuidArray(occurrences.filter((occurrence) => !occurrence.keep).map((occurrence) => occurrence.id));
        const turnIds = toPgUuidArray(occurrences.flatMap((occurrence) => (occurrence.turn_id ? [occurrence.turn_id] : [])));
        await tx`DELETE FROM ai.task_messages WHERE loop_id = ANY(${turnIds}::text[])`;
        await tx`
          DELETE FROM ai.turns WHERE id = ANY(${turnIds}::uuid[])
            AND status IN ('completed', 'failed', 'aborted') AND run_config ? 'background'
        `;
        await tx`DELETE FROM ai.chat_task_occurrences WHERE id = ANY(${occurrenceIds}::uuid[])`;
      }
      const remaining = limit - occurrences.length;
      if (remaining === 0) return occurrences.length;
      const orphanedTurns = await tx<{ id: string }[]>`
        SELECT turn.id FROM ai.turns turn
        WHERE turn.run_config ? 'background' AND turn.status IN ('completed', 'failed', 'aborted')
          AND turn.completed_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM ai.chat_task_occurrences occurrence WHERE occurrence.turn_id = turn.id
          )
        ORDER BY turn.completed_at, turn.id
        LIMIT ${remaining}
        FOR UPDATE OF turn SKIP LOCKED
      `;
      if (orphanedTurns.length === 0) return occurrences.length;
      const orphanedTurnIds = toPgUuidArray(orphanedTurns.map((turn) => turn.id));
      await tx`DELETE FROM ai.task_messages WHERE loop_id = ANY(${orphanedTurnIds}::text[])`;
      const removedTurns = await tx<{ id: string }[]>`
        DELETE FROM ai.turns WHERE id = ANY(${orphanedTurnIds}::uuid[])
          AND status IN ('completed', 'failed', 'aborted') AND run_config ? 'background'
        RETURNING id
      `;
      return occurrences.length + removedTurns.length;
    });
  },

  listQueuedOccurrences: async (limit = 100): Promise<Array<{ occurrence: AiChatTaskOccurrence; task: AiChatTask }>> => {
    const rows = await sql<(OccurrenceRow & TaskRow)[]>`
      SELECT occurrence.id, occurrence.short_id, occurrence.task_id, occurrence.scheduled_for, occurrence.trigger,
        occurrence.state, occurrence.turn_id, occurrence.error, occurrence.created_at, occurrence.started_at, occurrence.completed_at,
        task.id AS task_row_id, task.short_id AS task_short_id, task.conversation_id, conversation.short_id AS conversation_short_id,
        conversation.title AS conversation_title, task.sponsor_user_id, task.mandate_id, task.mandate_revision,
        (SELECT policy FROM auth.mandates WHERE id = task.mandate_id) AS mandate_policy,
        task.title, task.locale, task.reason_code, task.reason_at, task.prompt, task.schedule_kind, task.run_at, task.cron,
        task.timezone, task.state AS task_state, task.revision, task.last_error, task.created_at AS task_created_at, task.updated_at
      FROM (
        SELECT candidate.*,
          row_number() OVER (PARTITION BY task.id ORDER BY candidate.created_at, candidate.id) AS conversation_rank
        FROM ai.chat_task_occurrences candidate
        JOIN ai.chat_tasks task ON task.id = candidate.task_id
        JOIN ai.conversations conversation ON conversation.id = task.conversation_id
        WHERE candidate.state = 'queued' AND task.state = 'active'
          AND task.mandate_id IS NOT NULL AND task.mandate_revision IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ai.chat_task_occurrences running
            WHERE running.task_id = task.id AND running.state = 'running'
          )
      ) occurrence
      JOIN ai.chat_tasks task ON task.id = occurrence.task_id
      JOIN ai.conversations conversation ON conversation.id = task.conversation_id
      WHERE occurrence.conversation_rank = 1
      ORDER BY occurrence.created_at, occurrence.id
      LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map((row) => ({
      occurrence: toOccurrence(row),
      task: toTask({
        ...row,
        id: (row as typeof row & { task_row_id: string }).task_row_id,
        short_id: (row as typeof row & { task_short_id: string }).task_short_id,
        state: (row as typeof row & { task_state: AiChatTaskState }).task_state,
        created_at: (row as typeof row & { task_created_at: Date | string }).task_created_at,
      }),
    }));
  },

  getQueuedOccurrence: async (occurrenceId: string): Promise<{ occurrence: AiChatTaskOccurrence; task: AiChatTask } | null> => {
    return beginWithAppLocale(async (tx, appLocale) => {
      const occurrences = await tx<OccurrenceRow[]>`
        SELECT * FROM ai.chat_task_occurrences WHERE id = ${occurrenceId}::uuid AND state = 'queued' LIMIT 1
      `;
      const occurrence = occurrences[0];
      if (!occurrence) return null;
      const tasks = await tx<TaskRow[]>`
        ${taskSelect()}
        WHERE task.id = ${occurrence.task_id}::uuid AND task.state = 'active'
        LIMIT 1
        FOR UPDATE OF task
      `;
      if (!tasks[0]) return null;
      const task = await prepareTaskForExecution(tasks[0], tx, appLocale);
      if (!task) return null;
      await tx`
        UPDATE ai.chat_task_occurrences SET task_revision = ${task.revision}::bigint
        WHERE id = ${occurrence.id}::uuid AND state = 'queued'
      `;
      return { occurrence: toOccurrence(occurrence), task: toTask(task) };
    });
  },

  failOccurrence: async (input: { occurrenceId: string; error: string; code: ChatTaskReasonCode }): Promise<"failed" | "stale" | "gone"> =>
    beginWithAppLocale(async (tx, appLocale) => {
      const task = await loadOccurrenceTask(input.occurrenceId, tx);
      if (!task) return "gone" as const;
      const rows = await tx<{ task_id: string; task_revision: number | bigint }[]>`
        UPDATE ai.chat_task_occurrences occurrence
        SET state = 'failed', error = ${input.error}, completed_at = now()
        FROM ai.chat_tasks task
        WHERE occurrence.task_id = task.id
          AND occurrence.id = ${input.occurrenceId}::uuid
          AND occurrence.state IN ('queued', 'running')
          AND occurrence.task_revision = task.revision
        RETURNING occurrence.task_id, occurrence.task_revision
      `;
      if (rows[0]) {
        const revision = await pauseTerminalTaskMandate(task, tx);
        await tx`
          UPDATE ai.chat_tasks
          SET state = ${chatTaskReasonState(input.code)}, reason_code = ${input.code}, reason_at = CASE WHEN reason_code = ${input.code} THEN COALESCE(reason_at, now()) ELSE now() END, last_error = ${input.error}, mandate_revision = ${revision},
              revision = revision + 1, updated_at = now()
          WHERE id = ${rows[0].task_id}::uuid AND revision = ${rows[0].task_revision}::bigint
        `;
        const [stopped] = await tx<TaskRow[]>`SELECT * FROM ai.chat_tasks WHERE id = ${task.id}::uuid`;
        const reason = { code: input.code, at: iso(stopped!.reason_at!) };
        await deliverOccurrenceResult(tx, task, input.occurrenceId, reasonSentence(task, reason, appLocale), { reason, reasonOnly: true });
        return "failed" as const;
      }
      const stale = await tx<{ stale: boolean }[]>`
        SELECT true AS stale
        FROM ai.chat_task_occurrences occurrence
        JOIN ai.chat_tasks task ON task.id = occurrence.task_id
        WHERE occurrence.id = ${input.occurrenceId}::uuid
          AND occurrence.state IN ('queued', 'running')
          AND occurrence.task_revision <> task.revision
        LIMIT 1
      `;
      return stale[0] ? ("stale" as const) : ("gone" as const);
    }),

  deliverOccurrence: async (input: {
    occurrenceId: string;
    modelProfileId: string;
    runConfig: AiChatTurnRunConfig;
    userMessage: Message;
    expectedRevision: number;
  }): Promise<{ delivered: true; conversationId: string; turnId: string } | { delivered: false; reason: "not_found" | "busy" | "stale" }> =>
    beginWithAppLocale(async (tx, appLocale) => {
      const current = await loadOccurrenceTask(input.occurrenceId, tx);
      const task = current ? await prepareTaskForExecution(current, tx, appLocale) : null;
      if (!task) {
        return { delivered: false as const, reason: "not_found" as const };
      }
      const rows = await tx<
        {
          id: string;
          short_id: string;
          task_id: string;
          task_short_id: string;
          scheduled_for: Date | string;
          trigger: "scheduled" | "manual";
          state: AiChatTaskOccurrenceState;
          conversation_id: string;
          archived_at: Date | null;
          task_revision: number | bigint;
        }[]
      >`
        SELECT occurrence.id, occurrence.short_id, occurrence.task_id, occurrence.scheduled_for, occurrence.trigger,
          occurrence.state, task.short_id AS task_short_id, task.conversation_id, conversation.archived_at,
          task.revision AS task_revision
        FROM ai.chat_task_occurrences occurrence
        JOIN ai.chat_tasks task ON task.id = occurrence.task_id
        JOIN ai.conversations conversation ON conversation.id = task.conversation_id
        WHERE occurrence.id = ${input.occurrenceId}::uuid AND task.state = 'active'
        FOR UPDATE OF occurrence, task, conversation
      `;
      const occurrence = rows[0];
      if (!occurrence || occurrence.state !== "queued") return { delivered: false as const, reason: "not_found" as const };
      if (occurrence.archived_at) return { delivered: false as const, reason: "not_found" as const };
      if (Number(occurrence.task_revision) !== input.expectedRevision) return { delivered: false as const, reason: "stale" as const };
      const active = await tx<{ id: string }[]>`
        SELECT id FROM ai.chat_task_occurrences
        WHERE task_id = ${task.id}::uuid AND state = 'running'
        LIMIT 1
      `;
      if (active[0]) return { delivered: false as const, reason: "busy" as const };
      const mandate = requireTaskMandate(task);
      const contextRows = await tx<{ seq: number; kind: "message" | "summary"; message: Message }[]>`
        SELECT message.seq, message.kind, message.message FROM ai.messages message
        WHERE message.conversation_id = ${occurrence.conversation_id}::uuid AND message.compacted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ai.turns pending WHERE pending.id::text = message.loop_id
            AND pending.status IN ('queued','running','waiting_for_action'))
        ORDER BY message.seq
      `;
      const runConfig: AiChatTurnRunConfig = {
        ...input.runConfig,
        locale: chatTaskLocale(task.locale, appLocale),
        background: {
          taskId: task.short_id,
          occurrenceId: occurrence.short_id,
          scheduledFor: iso(occurrence.scheduled_for),
          trigger: occurrence.trigger,
          timezone: task.timezone,
          context: contextRows.map((row, index) => ({ seq: index + 1, kind: row.kind, message: row.message })),
        },
        mandate: { id: mandate.mandate_id, revision: Number(mandate.mandate_revision) },
      };
      const turn = await withAiShortIdForDb(
        tx,
        "idx_ai_turns_conversation_short_id",
        (attempt, shortId) => attempt<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
        VALUES (${shortId}, ${occurrence.conversation_id}::uuid, ${input.modelProfileId}, 'queued', (${JSON.stringify(runConfig)}::text)::jsonb)
        RETURNING id
      `,
      );
      const turnId = turn[0]!.id;
      const messageMeta: NonNullable<AiStoredMessage["meta"]> = {
        scheduledTask: {
          taskId: occurrence.task_short_id,
          occurrenceId: occurrence.short_id,
          scheduledFor: iso(occurrence.scheduled_for),
          trigger: occurrence.trigger,
        },
      };
      await withAiShortIdForDb(
        tx,
        "idx_ai_messages_conversation_short_id",
        (attempt, shortId) => attempt`
        INSERT INTO ai.task_messages (short_id, conversation_id, seq, kind, role, message, search_text, loop_id, meta)
        VALUES (
          ${shortId}, ${occurrence.conversation_id}::uuid,
          1,
          'message', 'user', (${JSON.stringify(input.userMessage)}::text)::jsonb, ${input.runConfig.input}, ${turnId}::uuid,
          (${JSON.stringify(messageMeta)}::text)::jsonb
        )
      `,
      );

      await tx`
        UPDATE ai.chat_task_occurrences
        SET state = 'running', turn_id = ${turnId}::uuid, task_revision = ${occurrence.task_revision}::bigint, started_at = now()
        WHERE id = ${occurrence.id}::uuid
      `;
      return { delivered: true as const, conversationId: occurrence.conversation_id, turnId };
    }),

  finalizeTurn: async (input: {
    turnId: string;
    status: AiTurnStatus;
    error?: string | null;
  }): Promise<{ occurrenceId: string; failed: boolean } | null> =>
    beginWithAppLocale(async (tx, appLocale) => {
      const task = await loadTurnTask(input.turnId, tx);
      // A plain read: the stop line claims the turn itself, after it locked the chat as archiving does.
      const [turn] = await tx<StoppedTurn[]>`SELECT id, conversation_id, cancellation_reason, run_config FROM ai.turns
        WHERE id = ${input.turnId}::uuid`;
      if (!turn) return null;
      if (turn.cancellation_reason === "routine_paused" || turn.cancellation_reason === "routine_deleted") {
        const text = await deliverStoppedTurn(
          tx,
          turn,
          turn.cancellation_reason === "routine_paused" ? "paused" : "deleted",
          task,
          appLocale,
        );
        const [occurrence] = await tx<{ id: string }[]>`UPDATE ai.chat_task_occurrences
          SET state = 'stopped', error = NULL, result_text = COALESCE(${text}, result_text), completed_at = now(), delivered_at = now()
          WHERE turn_id = ${input.turnId}::uuid AND state = 'running' RETURNING id`;
        return occurrence ? { occurrenceId: occurrence.id, failed: false } : null;
      }
      if (!task) return null;
      const rows = await tx<
        {
          occurrence_id: string;
          task_id: string;
          schedule_kind: "once" | "cron";
          trigger: "scheduled" | "manual";
          scheduled_for: Date | string;
          run_at: Date | string | null;
          task_revision: number | bigint;
          current_revision: number | bigint;
          turn_error: string | null;
          completed_at: Date | string;
        }[]
      >`
        UPDATE ai.chat_task_occurrences occurrence
        SET state = ${input.status === "completed" ? "completed" : "failed"},
            error = CASE
              WHEN ${input.status} = 'completed' THEN NULL
              ELSE COALESCE(${input.error ?? null}, turn.error, ${`Scheduled turn ${input.status}`})
            END,
            completed_at = now()
        FROM ai.chat_tasks task, ai.turns turn
        WHERE occurrence.task_id = task.id AND occurrence.turn_id = ${input.turnId}::uuid AND turn.id = occurrence.turn_id
          AND occurrence.state = 'running'
        RETURNING occurrence.id AS occurrence_id, occurrence.task_id, task.schedule_kind, occurrence.trigger,
          occurrence.scheduled_for, task.run_at, occurrence.task_revision, task.revision AS current_revision, turn.error AS turn_error, occurrence.completed_at
      `;
      const row = rows[0];
      if (!row) return null;
      const responses = await tx<{ message: Message }[]>`
        SELECT message FROM ai.task_messages WHERE loop_id = ${input.turnId} AND role = 'assistant' ORDER BY seq DESC
      `;
      const resultText =
        responses
          .map((response) => {
            const message = response.message;
            if (message.role !== "assistant" || message.content.some((part) => part.type === "tool_call")) return "";
            return message.content
              .filter((part) => typeof part === "string" || part.type === "text")
              .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
              .join("\n")
              .trim();
          })
          .find(Boolean) || (input.status === "completed" ? "Background task completed." : "");
      const unchangedSinceStart = Number(row.task_revision) === Number(row.current_revision);
      const currentOnceSlot = row.run_at !== null && iso(row.run_at) === iso(row.scheduled_for);
      if (
        unchangedSinceStart &&
        input.status === "completed" &&
        row.schedule_kind === "once" &&
        row.trigger === "scheduled" &&
        currentOnceSlot
      ) {
        const revision = await pauseTerminalTaskMandate(task, tx);
        await tx`
          UPDATE ai.chat_tasks
          SET state = 'completed', last_error = NULL, reason_code = NULL, reason_at = NULL, mandate_revision = ${revision}, revision = revision + 1, updated_at = now()
          WHERE id = ${row.task_id}::uuid AND revision = ${row.task_revision}::bigint
        `;
      } else if (unchangedSinceStart && input.status !== "completed") {
        const error = input.error || row.turn_error || `Scheduled turn ${input.status}`;
        const revision = await pauseTerminalTaskMandate(task, tx);
        await tx`
          UPDATE ai.chat_tasks
          SET state = ${chatTaskReasonState("failed")}, reason_code = 'failed', reason_at = CASE WHEN reason_code = 'failed' THEN COALESCE(reason_at, now()) ELSE now() END, last_error = ${error}, mandate_revision = ${revision}, revision = revision + 1, updated_at = now()
          WHERE id = ${row.task_id}::uuid AND revision = ${row.task_revision}::bigint
        `;
      }
      const [current] = await tx<TaskRow[]>`SELECT * FROM ai.chat_tasks WHERE id = ${task.id}::uuid`;
      const reason: ChatTaskReason | null =
        input.status !== "completed"
          ? { code: "failed", at: current?.reason_code === "failed" && current.reason_at ? iso(current.reason_at) : iso(row.completed_at) }
          : null;
      await deliverOccurrenceResult(
        tx,
        task,
        row.occurrence_id,
        resultText || (reason ? reasonSentence(task, reason, appLocale) : ""),
        reason ? { reason, ...(resultText ? {} : { reasonOnly: true as const }) } : {},
      );
      return { occurrenceId: row.occurrence_id, failed: input.status !== "completed" };
    }),

  listTerminalRunningTurns: async (limit = 100): Promise<Array<{ turnId: string; status: "completed" | "failed" | "aborted" }>> => {
    const rows = await sql<{ turn_id: string; status: "completed" | "failed" | "aborted" }[]>`
      SELECT turn_id, status FROM (
        (SELECT occurrence.turn_id, turn.status, turn.completed_at
          FROM ai.chat_task_occurrences occurrence JOIN ai.turns turn ON turn.id = occurrence.turn_id
          WHERE occurrence.state = 'running' AND turn.status IN ('completed', 'failed', 'aborted')
          ORDER BY turn.completed_at, occurrence.turn_id LIMIT ${Math.min(Math.max(limit, 1), 500)})
        UNION
        (SELECT turn.id AS turn_id, turn.status, turn.completed_at FROM ai.turns turn
          -- A paused run whose routine was deleted before its line went out has no occurrence left either.
          WHERE turn.cancellation_reason IN ('routine_deleted', 'routine_paused') AND turn.run_config ? 'background'
            AND turn.status IN ('completed', 'failed', 'aborted')
            AND NOT EXISTS (SELECT 1 FROM ai.chat_task_occurrences occurrence WHERE occurrence.turn_id = turn.id)
            AND turn.completed_at >= now() - interval '1 day'
            AND turn.run_config #>> '{background,stopDeliveredAt}' IS NULL
          ORDER BY turn.completed_at, turn.id LIMIT ${Math.min(Math.max(limit, 1), 500)})
      ) pending
      ORDER BY completed_at, turn_id LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map((row) => ({ turnId: row.turn_id, status: row.status }));
  },
} as const;
