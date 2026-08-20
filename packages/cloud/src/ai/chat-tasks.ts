import type { Message } from "@k2b/nessi";
import { sql } from "bun";
import { withAiShortId, withAiShortIdForDb } from "./short-id";
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
const taskFingerprint = (input: {
  chatId: string;
  prompt: string;
  schedule: AiChatTaskSchedule;
  timezone: string;
}): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([input.chatId, input.prompt.trim(), input.schedule, input.timezone]))
    .digest("hex");
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

export const aiChatTasks = {
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
    const rows = await withAiShortId(
      "ai_chat_tasks_short_id_unique",
      (shortId) => sql<TaskRow[]>`
      INSERT INTO ai.chat_tasks (
        short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, run_at, cron, timezone,
        idempotency_key, idempotency_fingerprint
      )
      SELECT ${shortId}, conversation.id, ${input.userId}::uuid, ${input.prompt.trim()}, ${input.schedule.kind},
        ${input.schedule.kind === "once" ? input.schedule.runAt : null}::timestamptz,
        ${input.schedule.kind === "cron" ? input.schedule.cron : null}, ${input.timezone}, ${scopedKey}, ${fingerprint}
      FROM ai.conversations conversation
      WHERE conversation.short_id = ${input.chatId}
        AND conversation.created_by_user_id = ${input.userId}::uuid
        AND conversation.archived_at IS NULL
      ON CONFLICT (sponsor_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING *, ${input.chatId} AS conversation_short_id,
        (SELECT title FROM ai.conversations WHERE short_id = ${input.chatId}) AS conversation_title
    `,
    );
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
      const current = rows[0];
      if (!current) return null;
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
              WHEN task.state = 'paused' THEN 'paused'
              WHEN task.state = 'completed' AND ${scheduleChanged} = false THEN 'completed'
              ELSE 'active'
            END,
            last_error = CASE
              WHEN task.state = 'paused' OR (task.state = 'completed' AND ${scheduleChanged} = false)
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
      return toTask(updated[0]!);
    }),

  setState: async (input: { userId: string; taskId: string; state: "active" | "paused" }): Promise<AiChatTask | null> => {
    const rows = await sql<TaskRow[]>`
      UPDATE ai.chat_tasks task
      SET state = ${input.state},
          last_error = CASE WHEN task.state = ${input.state} THEN task.last_error ELSE NULL END,
          revision = CASE WHEN task.state = ${input.state} THEN task.revision ELSE task.revision + 1 END,
          updated_at = CASE WHEN task.state = ${input.state} THEN task.updated_at ELSE now() END
      FROM ai.conversations conversation
      WHERE conversation.id = task.conversation_id
        AND task.sponsor_user_id = ${input.userId}::uuid
        AND task.short_id = ${input.taskId}
        AND (
          task.state = ${input.state}
          OR (task.state = 'active' AND ${input.state} = 'paused')
          OR (task.state = 'paused' AND ${input.state} = 'active')
          OR (task.state = 'needs_attention' AND task.schedule_kind = 'cron' AND ${input.state} = 'active')
        )
      RETURNING task.*, conversation.short_id AS conversation_short_id, conversation.title AS conversation_title
    `;
    return rows[0] ? toTask(rows[0]) : null;
  },

  delete: async (input: { userId: string; taskId: string }): Promise<boolean> => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM ai.chat_tasks task
      USING ai.conversations conversation
      WHERE conversation.id = task.conversation_id
        AND task.sponsor_user_id = ${input.userId}::uuid
        AND task.short_id = ${input.taskId}
      RETURNING task.id
    `;
    return Boolean(rows[0]);
  },

  listOccurrences: async (input: {
    userId: string;
    taskId: string;
    limit?: number;
  }): Promise<AiChatTaskOccurrence[] | null> => {
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
    `;
    return rows.map(toTask);
  },

  createOccurrence: async (input: {
    taskId: string;
    scheduledFor: string;
    trigger: "scheduled" | "manual";
    requestKey: string;
    expectedRevision?: number;
  }): Promise<AiChatTaskOccurrence | null> => {
    const rows = await withAiShortId(
      "ai_chat_task_occurrences_short_id_unique",
      (shortId) => sql<OccurrenceRow[]>`
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
    const existing = await sql<OccurrenceRow[]>`
      SELECT * FROM ai.chat_task_occurrences WHERE request_key = ${input.requestKey} LIMIT 1
    `;
    if (!existing[0]) return null;
    if (existing[0].task_id !== input.taskId) throw new AiChatTaskIdempotencyConflictError();
    return toOccurrence(existing[0]);
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
      const slot = iso(task.run_at);
      const occurrence = await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: slot,
        trigger: "scheduled",
        requestKey: `once:${task.id}:${slot}`,
        expectedRevision: Number(task.revision),
      });
      if (occurrence?.state === "queued") occurrences.push(occurrence);
    }
    return occurrences;
  },

  listQueuedOccurrences: async (limit = 100): Promise<Array<{ occurrence: AiChatTaskOccurrence; task: AiChatTask }>> => {
    const rows = await sql<(OccurrenceRow & TaskRow)[]>`
      SELECT occurrence.id, occurrence.short_id, occurrence.task_id, occurrence.scheduled_for, occurrence.trigger,
        occurrence.state, occurrence.turn_id, occurrence.error, occurrence.created_at, occurrence.started_at, occurrence.completed_at,
        task.id AS task_row_id, task.short_id AS task_short_id, task.conversation_id, conversation.short_id AS conversation_short_id,
        conversation.title AS conversation_title, task.sponsor_user_id, task.prompt, task.schedule_kind, task.run_at, task.cron,
        task.timezone, task.state AS task_state, task.revision, task.last_error, task.created_at AS task_created_at, task.updated_at
      FROM (
        SELECT candidate.*,
          row_number() OVER (PARTITION BY task.conversation_id ORDER BY candidate.created_at, candidate.id) AS conversation_rank
        FROM ai.chat_task_occurrences candidate
        JOIN ai.chat_tasks task ON task.id = candidate.task_id
        JOIN ai.conversations conversation ON conversation.id = task.conversation_id
        WHERE candidate.state = 'queued' AND task.state = 'active'
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
      `;
      if (!tasks[0]) return null;
      await tx`
        UPDATE ai.chat_task_occurrences SET task_revision = ${tasks[0].revision}::bigint
        WHERE id = ${occurrence.id}::uuid AND state = 'queued'
      `;
      return { occurrence: toOccurrence(occurrence), task: toTask(tasks[0]) };
    });
  },

  failOccurrence: async (input: { occurrenceId: string; error: string }): Promise<"failed" | "stale" | "gone"> =>
    sql.begin(async (tx) => {
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
        await tx`
          UPDATE ai.chat_tasks SET state = 'needs_attention', last_error = ${input.error}, revision = revision + 1, updated_at = now()
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
  }): Promise<{ delivered: true; conversationId: string; turnId: string } | { delivered: false; reason: "not_found" | "busy" | "stale" }> =>
    sql.begin(async (tx) => {
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
      const turn = await withAiShortIdForDb(
        tx,
        "idx_ai_turns_conversation_short_id",
        (attempt, shortId) => attempt<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
        VALUES (${shortId}, ${occurrence.conversation_id}::uuid, ${input.modelProfileId}, 'queued', (${JSON.stringify(input.runConfig)}::text)::jsonb)
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
        await tx`
          UPDATE ai.chat_tasks SET state = 'completed', last_error = NULL, revision = revision + 1, updated_at = now()
          WHERE id = ${row.task_id}::uuid AND revision = ${row.task_revision}::bigint
        `;
      } else if (unchangedSinceStart && input.status !== "completed") {
        const error = input.error || row.turn_error || `Scheduled turn ${input.status}`;
        await tx`
          UPDATE ai.chat_tasks SET state = 'needs_attention', last_error = ${error}, revision = revision + 1, updated_at = now()
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
