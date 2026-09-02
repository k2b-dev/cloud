import type { Message } from "@k2b/nessi";
import { type SQL, sql } from "bun";
import { invocationIssuanceMode } from "../services/identity/invocation-runtime";
import { logger } from "../services/logging";
import {
  createMandate,
  type Mandate,
  type MandatePolicyV1,
  MandatePolicyV1Schema,
  pauseMandate,
  resumeMandate,
  revokeMandate,
} from "../services/mandates";
import { parsePgJsonValue } from "../services/postgres";
import { withAiShortIdForDb } from "./short-id";
import type { AiChatTurnRunConfig, AiStoredMessage, AiTurnStatus } from "./types";

export type AiChatTaskState = "active" | "paused" | "completed" | "needs_attention";
export type AiChatTaskSchedule = { kind: "once"; runAt: string } | { kind: "cron"; cron: string };
export type AiChatTask = {
  id: string;
  shortId: string;
  chatId: string;
  chatTitle: string;
  conversationId: string;
  sponsorUserId: string;
  mandateId: string | null;
  mandateRevision: number | null;
  prompt: string;
  schedule: AiChatTaskSchedule;
  timezone: string;
  state: AiChatTaskState;
  revision: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiChatTaskOccurrenceState = "queued" | "running" | "completed" | "failed";
export type AiChatTaskOccurrence = {
  id: string;
  shortId: string;
  taskId: string;
  scheduledFor: string;
  trigger: "scheduled" | "manual";
  state: AiChatTaskOccurrenceState;
  turnId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type TaskRow = {
  id: string;
  short_id: string;
  conversation_id: string;
  conversation_short_id: string;
  conversation_title: string;
  sponsor_user_id: string;
  mandate_id: string | null;
  mandate_revision: number | bigint | null;
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
class AiChatTaskAuthorityError extends Error {}
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
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const nullableIso = (value: Date | string | null): string | null => (value === null ? null : iso(value));
const taskIdempotencyKey = (key: string): string => `task.create:${key}`;
const CHAT_TASK_MANDATE_POLICY = {
  version: 1,
  apps: "*",
  operations: "*",
  actions: "require_approval",
} as const satisfies MandatePolicyV1;
const mandateAuthority = (userId: string) => ({ kind: "interactive" as const, userId });
const mandateMigrationAuthority = (sponsorUserId: string) => ({
  kind: "system" as const,
  migration: "ai.chat-task" as const,
  sponsorUserId,
});
const mandateWorkloadAuthority = { kind: "workload" as const, ownerAppId: "core" };
const mandateError = (operation: string, result: { ok: false; error: { message: string } }): Error =>
  new AiChatTaskAuthorityError(`Could not ${operation} scheduled task mandate: ${result.error.message}`);
const isChatTaskMandatePolicy = (policy: MandatePolicyV1): boolean =>
  policy.version === CHAT_TASK_MANDATE_POLICY.version &&
  policy.apps === CHAT_TASK_MANDATE_POLICY.apps &&
  policy.operations === CHAT_TASK_MANDATE_POLICY.operations &&
  policy.actions === CHAT_TASK_MANDATE_POLICY.actions;
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
  if (!task.mandate_id || task.mandate_revision === null) throw new Error("Scheduled task mandate is unavailable");
  return { mandate_id: task.mandate_id, mandate_revision: task.mandate_revision };
};
const ensureTaskMandate = async (task: TaskRow, db: SQL): Promise<TaskRow> => {
  if (task.mandate_id && task.mandate_revision !== null) return task;
  if (task.mandate_id || task.mandate_revision !== null) throw new AiChatTaskAuthorityError("Scheduled task mandate state is inconsistent");

  const created = await createMandate(
    {
      authority: mandateMigrationAuthority(task.sponsor_user_id),
      subject: { type: "user", id: task.sponsor_user_id },
      ownerAppId: "core",
      workloadType: "ai.chat-task",
      workloadId: task.id,
      policy: CHAT_TASK_MANDATE_POLICY,
    },
    { db },
  );
  let mandate: Pick<Mandate, "id" | "revision" | "state">;
  if (created.ok) {
    mandate = created.data;
  } else {
    const [candidate] = await db<{ id: string }[]>`
      SELECT id FROM auth.mandates
      WHERE owner_app_id = 'core' AND workload_type = 'ai.chat-task' AND workload_id = ${task.id}
        AND state IN ('active', 'paused') AND confirmed_at IS NOT NULL
      LIMIT 1
      FOR UPDATE
    `;
    const existing = candidate ? await loadTaskMandate({ ...task, mandate_id: candidate.id }, db) : null;
    const policy = existing ? taskMandatePolicy(existing) : null;
    if (
      !existing ||
      !taskMandateMatches(task, existing) ||
      !existing.confirmed_at ||
      !existing.unexpired ||
      !policy ||
      !isChatTaskMandatePolicy(policy)
    ) {
      throw mandateError("recover", created);
    }
    mandate = { id: existing.id, revision: Number(existing.revision), state: existing.state };
  }

  let revision = mandate.revision;
  if (task.state === "active" && mandate.state === "paused") {
    throw new AiChatTaskAuthorityError("Could not recover scheduled task mandate: active legacy task has a paused mandate");
  } else if (task.state !== "active" && mandate.state === "active") {
    const paused = await pauseMandate({ mandateId: mandate.id, expectedRevision: revision, authority: mandateWorkloadAuthority }, { db });
    if (!paused.ok) throw mandateError("pause", paused);
    revision = paused.data.revision;
  }
  await db`
    UPDATE ai.chat_tasks SET mandate_id = ${mandate.id}::uuid, mandate_revision = ${revision}
    WHERE id = ${task.id}::uuid AND mandate_id IS NULL AND mandate_revision IS NULL
  `;
  return { ...task, mandate_id: mandate.id, mandate_revision: revision };
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
  state: "paused" | "needs_attention",
  reason: string | null,
  db: SQL,
  pausedMandateRevision?: number,
): Promise<null> => {
  await db`
    UPDATE ai.chat_tasks
    SET state = ${state}, last_error = ${reason},
        mandate_revision = COALESCE(${pausedMandateRevision ?? null}::bigint, mandate_revision),
        revision = revision + 1, updated_at = now()
    WHERE id = ${task.id}::uuid AND state = 'active'
  `;
  return null;
};
/** The caller holds the task lock; mandate and sponsor locks remain held until turn admission commits. */
const prepareTaskForExecution = async (input: TaskRow, db: SQL): Promise<TaskRow | null> => {
  if (input.state !== "active") return null;
  let task: TaskRow;
  try {
    task = await ensureTaskMandate(input, db);
  } catch (error) {
    if (!(error instanceof AiChatTaskAuthorityError)) throw error;
    return stopTaskAdmission(input, "needs_attention", error.message, db);
  }
  const mandate = await loadTaskMandate(task, db);
  const policy = mandate ? taskMandatePolicy(mandate) : null;
  const [sponsor] = await db<{ id: string }[]>`
    SELECT sponsor.id FROM auth.users sponsor
    JOIN ai.conversations conversation ON conversation.created_by_user_id = sponsor.id
    WHERE sponsor.id = ${task.sponsor_user_id}::uuid AND conversation.id = ${task.conversation_id}::uuid
      AND (sponsor.account_expires IS NULL OR sponsor.account_expires > now()) AND conversation.archived_at IS NULL
    FOR SHARE OF sponsor
    FOR UPDATE OF conversation
  `;
  if (
    !sponsor ||
    !mandate ||
    !taskMandateMatches(task, mandate) ||
    !mandate.confirmed_at ||
    !mandate.unexpired ||
    !policy ||
    !isChatTaskMandatePolicy(policy) ||
    mandate.state === "revoked"
  ) {
    return stopTaskAdmission(task, "needs_attention", "Scheduled task mandate or sponsor is unavailable", db);
  }
  if (mandate.state === "paused") return stopTaskAdmission(task, "paused", null, db, Number(mandate.revision));
  if (task.mandate_revision === null || Number(task.mandate_revision) !== Number(mandate.revision)) {
    return stopTaskAdmission(task, "needs_attention", "Scheduled task mandate revision changed", db);
  }
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
const taskFingerprint = (input: { chatId: string; prompt: string; schedule: AiChatTaskSchedule; timezone: string }): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify([input.chatId, input.prompt.trim(), input.schedule, input.timezone])).digest("hex");
const taskSelect = sql`
  SELECT task.*, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title
  FROM ai.chat_tasks task
  JOIN ai.conversations conversation ON conversation.id = task.conversation_id
`;

const toTask = (row: TaskRow): AiChatTask => ({
  id: row.id,
  shortId: row.short_id,
  chatId: row.conversation_short_id,
  chatTitle: row.conversation_title,
  conversationId: row.conversation_id,
  sponsorUserId: row.sponsor_user_id,
  mandateId: row.mandate_id,
  mandateRevision: row.mandate_revision === null ? null : Number(row.mandate_revision),
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
  createdAt: iso(row.created_at),
  startedAt: nullableIso(row.started_at),
  completedAt: nullableIso(row.completed_at),
});

const prepareTaskById = (taskId: string): Promise<AiChatTask | null> =>
  sql.begin(async (tx) => {
    const [task] = await tx<TaskRow[]>`
      ${taskSelect}
      WHERE task.id = ${taskId}::uuid
      FOR UPDATE OF task
    `;
    const prepared = task ? await prepareTaskForExecution(task, tx) : null;
    return prepared ? toTask(prepared) : null;
  });
const loadOccurrenceTask = async (occurrenceId: string, db: SQL): Promise<TaskRow | null> => {
  const [task] = await db<TaskRow[]>`
    ${taskSelect}
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
    ${taskSelect}
    WHERE EXISTS (
      SELECT 1 FROM ai.chat_task_occurrences occurrence
      WHERE occurrence.turn_id = ${turnId}::uuid AND occurrence.task_id = task.id
    )
    FOR UPDATE OF task
  `;
  return task ?? null;
};

export const aiChatTasks = {
  prepareLegacyMandates: async (limit = 100): Promise<{ prepared: number; remaining: boolean }> => {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM ai.chat_tasks
      WHERE state = 'active' AND mandate_id IS NULL AND mandate_revision IS NULL
      ORDER BY created_at, id
      LIMIT ${boundedLimit}
    `;
    let prepared = 0;
    for (const row of rows) {
      try {
        if (await prepareTaskById(row.id)) prepared += 1;
      } catch (error) {
        log.warn("Scheduled task mandate recovery failed", {
          taskId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const [remaining] = await sql<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ai.chat_tasks
        WHERE state = 'active' AND mandate_id IS NULL AND mandate_revision IS NULL
      ) AS present
    `;
    return { prepared, remaining: remaining?.present === true };
  },

  list: async (input: {
    userId: string;
    chatId?: string;
    state?: AiChatTaskState;
    limit?: number;
    offset?: number;
  }): Promise<AiChatTask[]> => {
    const rows = await sql<TaskRow[]>`
      ${taskSelect}
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
      ${taskSelect}
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
    schedule: AiChatTaskSchedule;
    timezone: string;
    idempotencyKey?: string;
    idempotencyFingerprint?: string;
  }): Promise<AiChatTask | null> => {
    const scopedKey = input.idempotencyKey ? taskIdempotencyKey(input.idempotencyKey) : null;
    const fingerprint = scopedKey ? (input.idempotencyFingerprint ?? taskFingerprint(input)) : null;
    if (input.idempotencyKey) {
      const existing = await sql<(TaskRow & { idempotency_fingerprint: string | null })[]>`
        ${taskSelect}
        WHERE task.idempotency_key = ${scopedKey}
          AND task.sponsor_user_id = ${input.userId}::uuid
        LIMIT 1
      `;
      if (existing[0]) {
        if (existing[0].idempotency_fingerprint !== fingerprint) throw new AiChatTaskIdempotencyConflictError();
        return toTask(existing[0]);
      }
    }
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
            policy: CHAT_TASK_MANDATE_POLICY,
          },
          { db: tx },
        );
        if (!mandate.ok) throw mandateError("create", mandate);
        const inserted = await withAiShortIdForDb(
          tx,
          "ai_chat_tasks_short_id_unique",
          (attempt, shortId) => attempt<TaskRow[]>`
          INSERT INTO ai.chat_tasks (
            id, short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, run_at, cron, timezone,
            mandate_id, mandate_revision, idempotency_key, idempotency_fingerprint
          )
          VALUES (
            ${taskId}::uuid, ${shortId}, ${conversation.id}::uuid, ${input.userId}::uuid, ${input.prompt.trim()}, ${input.schedule.kind},
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
        return inserted;
      });
    } catch (error) {
      if (!(error instanceof AiChatTaskCreateRace)) throw error;
      rows = [];
    }
    if (rows[0]) return toTask(rows[0]);
    if (!input.idempotencyKey) return null;
    const existing = await sql<(TaskRow & { idempotency_fingerprint: string | null })[]>`
      ${taskSelect}
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
      ${taskSelect}
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
    schedule?: AiChatTaskSchedule;
    timezone?: string;
  }): Promise<AiChatTask | null> =>
    sql.begin(async (tx) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect}
        WHERE task.sponsor_user_id = ${input.userId}::uuid
          AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return null;
      const wasActive = current.state === "active";
      const authorityStopped = wasActive && !(await prepareTaskForExecution(current, tx));
      if (authorityStopped) {
        [current] = await tx<TaskRow[]>`${taskSelect} WHERE task.id = ${current.id}::uuid`;
        if (!current) return null;
      } else {
        current = await ensureTaskMandate(current, tx);
      }
      const nextTimezone = input.timezone ?? current.timezone;
      const scheduleChanged = input.schedule
        ? input.schedule.kind !== current.schedule_kind ||
          (input.schedule.kind === "once" ? iso(input.schedule.runAt) !== iso(current.run_at!) : input.schedule.cron !== current.cron) ||
          nextTimezone !== current.timezone
        : false;
      const promptChanged = input.prompt !== undefined && input.prompt.trim() !== current.prompt;
      if (!promptChanged && !scheduleChanged) return toTask(current);
      await tx`
        UPDATE ai.chat_tasks task
        SET prompt = ${input.prompt?.trim() ?? current.prompt},
            schedule_kind = ${input.schedule?.kind ?? current.schedule_kind},
            run_at = ${input.schedule ? (input.schedule.kind === "once" ? input.schedule.runAt : null) : current.run_at}::timestamptz,
            cron = ${input.schedule ? (input.schedule.kind === "cron" ? input.schedule.cron : null) : current.cron},
            timezone = ${input.timezone ?? current.timezone},
            state = CASE
              WHEN ${authorityStopped} THEN task.state
              WHEN task.state = 'paused' THEN 'paused'
              WHEN task.state = 'completed' AND ${scheduleChanged} = false THEN 'completed'
              ELSE 'active'
            END,
            last_error = CASE
              WHEN ${authorityStopped} OR task.state = 'paused' OR (task.state = 'completed' AND ${scheduleChanged} = false)
                THEN task.last_error
              ELSE NULL
            END,
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
      const updated = await tx<TaskRow[]>`${taskSelect} WHERE task.id = ${current.id}::uuid`;
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

  setState: async (input: { userId: string; taskId: string; state: "active" | "paused" }): Promise<AiChatTask | null> => {
    return sql.begin(async (tx) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect}
        WHERE task.sponsor_user_id = ${input.userId}::uuid AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return null;
      current = await ensureTaskMandate(current, tx);
      const allowed =
        current.state === input.state ||
        (current.state === "active" && input.state === "paused") ||
        (current.state === "paused" && input.state === "active") ||
        (current.state === "needs_attention" && current.schedule_kind === "cron" && input.state === "active");
      if (!allowed) return null;
      const revision = await mandateRevision(requireTaskMandate(current), input.state, input.userId, tx);
      const updated = await tx<TaskRow[]>`
        UPDATE ai.chat_tasks task
        SET state = ${input.state}, mandate_revision = ${revision},
            last_error = CASE WHEN task.state = ${input.state} THEN task.last_error ELSE NULL END,
            revision = CASE WHEN task.state = ${input.state} THEN task.revision ELSE task.revision + 1 END,
            updated_at = CASE WHEN task.state = ${input.state} THEN task.updated_at ELSE now() END
        FROM ai.conversations conversation
        WHERE conversation.id = task.conversation_id AND task.id = ${current.id}::uuid
        RETURNING task.*, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title
      `;
      return updated[0] ? toTask(updated[0]) : null;
    });
  },

  delete: async (input: { userId: string; taskId: string }): Promise<boolean> => {
    return sql.begin(async (tx) => {
      const rows = await tx<TaskRow[]>`
        ${taskSelect}
        WHERE task.sponsor_user_id = ${input.userId}::uuid AND task.short_id = ${input.taskId}
        FOR UPDATE OF task
      `;
      let current = rows[0];
      if (!current) return false;
      current = await ensureTaskMandate(current, tx);
      const mandate = requireTaskMandate(current);
      const revoked = await revokeMandate(
        {
          mandateId: mandate.mandate_id,
          expectedRevision: Number(mandate.mandate_revision),
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
      ${taskSelect}
      WHERE task.state = 'active' AND task.schedule_kind = 'cron'
        AND task.mandate_id IS NOT NULL AND task.mandate_revision IS NOT NULL
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
    return sql.begin(async (tx) => {
      const [current] = await tx<TaskRow[]>`${taskSelect} WHERE task.id = ${input.taskId}::uuid FOR UPDATE OF task`;
      if (!current || !(await prepareTaskForExecution(current, tx))) return null;
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

  listQueuedOccurrences: async (limit = 100): Promise<Array<{ occurrence: AiChatTaskOccurrence; task: AiChatTask }>> => {
    if (invocationIssuanceMode() !== "jwt") return [];
    try {
      await aiChatTasks.prepareLegacyMandates(limit);
    } catch (error) {
      log.warn("Scheduled task legacy preparation failed", { error: error instanceof Error ? error.message : String(error) });
    }
    const rows = await sql<(OccurrenceRow & TaskRow)[]>`
      SELECT occurrence.id, occurrence.short_id, occurrence.task_id, occurrence.scheduled_for, occurrence.trigger,
        occurrence.state, occurrence.turn_id, occurrence.error, occurrence.created_at, occurrence.started_at, occurrence.completed_at,
        task.id AS task_row_id, task.short_id AS task_short_id, task.conversation_id, conversation.short_id AS conversation_short_id,
        conversation.title AS conversation_title, task.sponsor_user_id, task.mandate_id, task.mandate_revision,
        task.prompt, task.schedule_kind, task.run_at, task.cron,
        task.timezone, task.state AS task_state, task.revision, task.last_error, task.created_at AS task_created_at, task.updated_at
      FROM (
        SELECT candidate.*,
          row_number() OVER (PARTITION BY task.conversation_id ORDER BY candidate.created_at, candidate.id) AS conversation_rank
        FROM ai.chat_task_occurrences candidate
        JOIN ai.chat_tasks task ON task.id = candidate.task_id
        JOIN ai.conversations conversation ON conversation.id = task.conversation_id
        WHERE candidate.state = 'queued' AND task.state = 'active'
          AND task.mandate_id IS NOT NULL AND task.mandate_revision IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ai.turns turn
            WHERE turn.conversation_id = task.conversation_id
              AND turn.status IN ('queued', 'running', 'waiting_for_action')
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
    if (invocationIssuanceMode() !== "jwt") return null;
    return sql.begin(async (tx) => {
      const occurrences = await tx<OccurrenceRow[]>`
        SELECT * FROM ai.chat_task_occurrences WHERE id = ${occurrenceId}::uuid AND state = 'queued' LIMIT 1
      `;
      const occurrence = occurrences[0];
      if (!occurrence) return null;
      const tasks = await tx<TaskRow[]>`
        ${taskSelect}
        WHERE task.id = ${occurrence.task_id}::uuid AND task.state = 'active'
        LIMIT 1
        FOR UPDATE OF task
      `;
      if (!tasks[0]) return null;
      const task = await prepareTaskForExecution(tasks[0], tx);
      if (!task) return null;
      await tx`
        UPDATE ai.chat_task_occurrences SET task_revision = ${task.revision}::bigint
        WHERE id = ${occurrence.id}::uuid AND state = 'queued'
      `;
      return { occurrence: toOccurrence(occurrence), task: toTask(task) };
    });
  },

  failOccurrence: async (input: { occurrenceId: string; error: string }): Promise<"failed" | "stale" | "gone"> =>
    sql.begin(async (tx) => {
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
          SET state = 'needs_attention', last_error = ${input.error}, mandate_revision = ${revision},
              revision = revision + 1, updated_at = now()
          WHERE id = ${rows[0].task_id}::uuid AND revision = ${rows[0].task_revision}::bigint
        `;
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
  }): Promise<
    { delivered: true; conversationId: string; turnId: string } | { delivered: false; reason: "not_found" | "busy" | "stale" | "held" }
  > =>
    sql.begin(async (tx) => {
      if (invocationIssuanceMode() !== "jwt") return { delivered: false as const, reason: "held" as const };
      const current = await loadOccurrenceTask(input.occurrenceId, tx);
      const task = current ? await prepareTaskForExecution(current, tx) : null;
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
        SELECT id FROM ai.turns
        WHERE conversation_id = ${occurrence.conversation_id}::uuid
          AND status IN ('queued', 'running', 'waiting_for_action')
        LIMIT 1
      `;
      if (active[0]) return { delivered: false as const, reason: "busy" as const };
      const mandate = requireTaskMandate(task);
      const runConfig: AiChatTurnRunConfig = {
        ...input.runConfig,
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
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text, loop_id, meta)
        VALUES (
          ${shortId}, ${occurrence.conversation_id}::uuid,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM ai.messages WHERE conversation_id = ${occurrence.conversation_id}::uuid AND seq > 0),
          'message', 'user', (${JSON.stringify(input.userMessage)}::text)::jsonb, ${input.runConfig.input}, ${turnId}::uuid,
          (${JSON.stringify(messageMeta)}::text)::jsonb
        )
      `,
      );
      await tx`UPDATE ai.conversations SET updated_at = now() WHERE id = ${occurrence.conversation_id}::uuid`;
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
    sql.begin(async (tx) => {
      const task = await loadTurnTask(input.turnId, tx);
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
          occurrence.scheduled_for, task.run_at, occurrence.task_revision, task.revision AS current_revision, turn.error AS turn_error
      `;
      const row = rows[0];
      if (!row) return null;
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
          SET state = 'completed', last_error = NULL, mandate_revision = ${revision}, revision = revision + 1, updated_at = now()
          WHERE id = ${row.task_id}::uuid AND revision = ${row.task_revision}::bigint
        `;
      } else if (unchangedSinceStart && input.status !== "completed") {
        const error = input.error || row.turn_error || `Scheduled turn ${input.status}`;
        const revision = await pauseTerminalTaskMandate(task, tx);
        await tx`
          UPDATE ai.chat_tasks
          SET state = 'needs_attention', last_error = ${error}, mandate_revision = ${revision}, revision = revision + 1, updated_at = now()
          WHERE id = ${row.task_id}::uuid AND revision = ${row.task_revision}::bigint
        `;
      }
      return { occurrenceId: row.occurrence_id, failed: input.status !== "completed" };
    }),

  listTerminalRunningTurns: async (limit = 100): Promise<Array<{ turnId: string; status: "completed" | "failed" | "aborted" }>> => {
    const rows = await sql<{ turn_id: string; status: "completed" | "failed" | "aborted" }[]>`
      SELECT occurrence.turn_id, turn.status
      FROM ai.chat_task_occurrences occurrence
      JOIN ai.chat_tasks task ON task.id = occurrence.task_id
      JOIN ai.conversations conversation ON conversation.id = task.conversation_id
      JOIN ai.turns turn ON turn.id = occurrence.turn_id
      WHERE occurrence.state = 'running'
        AND turn.status IN ('completed', 'failed', 'aborted')
      ORDER BY turn.completed_at, occurrence.id
      LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map((row) => ({ turnId: row.turn_id, status: row.status }));
  },
} as const;
