import { toPgTextArray } from "@k2b/cloud/services/postgres";
import { i18n } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { type BoundNotificationMap, lazySync, notification } from "@k2b/cloud";
import { AI_SHORT_ID_PATTERN } from "@k2b/cloud/ai";
import { coreSettings, getFreeIpaConfig, logger, notifications, trace } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";

const RECOVERY_SCHEDULER_ID = "core-ai-notifications";
const RECOVERY_SCHEDULE_ID = "core:ai-notifications:recover";
const RECOVERY_BATCH_SIZE = 100;

const log = logger("core:ai-notifications");
const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });
const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      costWarning: "Background AI cost warning",
      costStop: "Background AI stopped",
      costBody: ({ cost, unit }: { cost: number; unit: string }) =>
        `Reference costs over the last 24 hours: ${cost} ${unit}. Review Usage rules and the contributing workflows.`,
      responseReady: "Assistant response ready",
      responseFinished: "Your Assistant response has finished.",
      responseEmail: ({ target }: { target: string }) => `Your Assistant response has finished. Open it at ${target}`,
      taskAttention: ({ taskId }: { taskId: string }) => `Scheduled task ${taskId} needs attention`,
    },
    de: {
      costWarning: "Kostenwarnung für Hintergrund-AI",
      costStop: "Hintergrund-AI angehalten",
      costBody: ({ cost, unit }) =>
        `Referenzkosten der letzten 24 Stunden: ${cost} ${unit}. Prüfe die Usage-Regeln und die verursachenden Workflows.`,
      responseReady: "Antwort des Assistenten ist bereit",
      responseFinished: "Die Antwort des Assistenten ist fertig.",
      responseEmail: ({ target }) => `Die Antwort des Assistenten ist fertig. Öffne sie unter ${target}`,
      taskAttention: ({ taskId }) => `Geplante Aufgabe ${taskId} erfordert deine Aufmerksamkeit`,
    },
  },
});
const text = (locale: string) => notificationMessages.resolve([locale]).t;

export const AI_NOTIFICATIONS = {
  backgroundCosts: notification({
    recipient: "user",
    label: "Background AI cost alerts",
    description: "Warnings and emergency stops for background inference costs.",
    presentation: presentation("Hintergrund-AI-Kosten", "Kostenwarnungen und Notbremsen für Hintergrund-AI."),
    delivery: { recommended: ["browser"] },
    data: z.object({ kind: z.enum(["warning", "stop"]), cost: z.number(), unit: z.string() }),
    render: (data, { locale }) => ({
      title: data.kind === "stop" ? text(locale).costStop : text(locale).costWarning,
      body: text(locale).costBody(data),
      targetHref: "/admin/settings?tab=ai-quotas&view=rules",
    }),
    email: (data, { locale }) => ({
      subject: data.kind === "stop" ? text(locale).costStop : text(locale).costWarning,
      content: text(locale).costBody(data),
    }),
  }),
  turnCompleted: notification({
    recipient: "user",
    label: "Assistant responses",
    description: "A notification when a background Assistant response finishes.",
    presentation: presentation("Antworten des Assistenten", "Benachrichtigung, wenn eine Antwort im Hintergrund fertig ist."),
    delivery: { recommended: ["browser"] },
    data: z.object({ conversationId: z.string().regex(AI_SHORT_ID_PATTERN) }),
    render: ({ conversationId }, { locale }) => ({
      title: text(locale).responseReady,
      body: text(locale).responseFinished,
      targetHref: `/app/assistant?conversation=${encodeURIComponent(conversationId)}`,
    }),
    email: async ({ conversationId }, { locale }) => {
      const configuredUrl = String((await coreSettings.get<string>("app.url")) || "").trim();
      const baseUrl = /^https?:\/\//.test(configuredUrl) ? configuredUrl : configuredUrl ? `https://${configuredUrl}` : "";
      const target = `/app/assistant?conversation=${encodeURIComponent(conversationId)}`;
      return {
        subject: text(locale).responseReady,
        content: text(locale).responseEmail({ target: baseUrl ? `${baseUrl.replace(/\/+$/, "")}${target}` : target }),
      };
    },
  }),
  taskNeedsAttention: notification({
    recipient: "user",
    label: "Assistant scheduled tasks",
    description: "A notification when a scheduled Assistant task cannot continue.",
    presentation: presentation(
      "Geplante Aufgaben des Assistenten",
      "Benachrichtigung, wenn eine geplante Aufgabe nicht fortgesetzt werden kann.",
    ),
    delivery: { recommended: ["browser"] },
    data: z.object({
      conversationId: z.string().regex(AI_SHORT_ID_PATTERN),
      taskId: z.string().regex(AI_SHORT_ID_PATTERN),
      error: z.string(),
    }),
    render: ({ conversationId, taskId, error }, { locale }) => ({
      title: text(locale).taskAttention({ taskId }),
      body: error,
      targetHref: `/app/assistant?conversation=${encodeURIComponent(conversationId)}`,
    }),
  }),
};

type AiNotificationDefinitions = BoundNotificationMap<"core", typeof AI_NOTIFICATIONS>;

type CompletionCandidate = {
  turn_id: string;
  conversation_id: string;
  user_id: string;
};

type TaskAttentionCandidate = {
  occurrence_id: string;
  conversation_id: string;
  task_id: string;
  user_id: string;
  error: string;
};

type AiNotificationRecoverySummary = {
  scanned: number;
  sent: number;
  failed: number;
};

export const createAiNotificationService = (definitions: AiNotificationDefinitions) => {
  const recoveryScheduler = lazySync((sync) => {
    const handle = sync.scheduler({ id: RECOVERY_SCHEDULER_ID, delivery: { maxAttempts: 4, backoffMs: [5_000, 10_000, 20_000] } });

    return handle;
  });
  let worker: Worker | undefined;

  const recoverCompletions = async (input: { turnId?: string; limit?: number } = {}): Promise<AiNotificationRecoverySummary> => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? RECOVERY_BATCH_SIZE), 1), 1_000);
    const candidates = await sql<CompletionCandidate[]>`
      SELECT turn.id AS turn_id,
             conversation.short_id AS conversation_id,
             conversation.created_by_user_id AS user_id
      FROM ai.turns turn
      JOIN ai.conversations conversation ON conversation.id = turn.conversation_id
      JOIN notifications.definitions definition ON definition.id = ${definitions.turnCompleted.id}
      WHERE turn.status = 'completed'
        AND turn.completed_at >= definition.first_seen_at
        AND turn.run_config->>'kind' = 'chat'
        AND conversation.created_by_user_id IS NOT NULL
        AND (${input.turnId ?? null}::uuid IS NULL OR turn.id = ${input.turnId ?? null}::uuid)
        AND NOT EXISTS (
          SELECT 1
          FROM notifications.events event
          WHERE event.definition_id = ${definitions.turnCompleted.id}
            AND event.idempotency_key = 'turn:' || turn.id::text
        )
      ORDER BY turn.completed_at, turn.id
      LIMIT ${limit}
    `;

    const locale = await coreSettings.get<string>("app.locale");
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await notifications.send(definitions.turnCompleted, {
          recipient: { userId: candidate.user_id },
          data: { conversationId: candidate.conversation_id },
          idempotencyKey: `turn:${candidate.turn_id}`,
          locale,
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        log.warn("Failed to create Assistant completion notification", {
          conversationId: candidate.conversation_id,
          turnId: candidate.turn_id,
          error: error instanceof Error ? error.message : "Notification creation failed",
        });
      }
    }
    if (failed > 0) throw new Error(`Failed to create ${failed} Assistant completion notification(s).`);
    return { scanned: candidates.length, sent, failed };
  };

  const recoverTaskAttention = async (input: { occurrenceId?: string; limit?: number } = {}): Promise<AiNotificationRecoverySummary> => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? RECOVERY_BATCH_SIZE), 1), 1_000);
    const candidates = await sql<TaskAttentionCandidate[]>`
      SELECT occurrence.id AS occurrence_id,
             conversation.short_id AS conversation_id,
             task.short_id AS task_id,
             task.sponsor_user_id AS user_id,
             occurrence.error
      FROM ai.chat_task_occurrences occurrence
      JOIN ai.chat_tasks task ON task.id = occurrence.task_id
      JOIN ai.conversations conversation ON conversation.id = task.conversation_id
      JOIN notifications.definitions definition ON definition.id = ${definitions.taskNeedsAttention.id}
      WHERE occurrence.state = 'failed'
        AND occurrence.completed_at >= definition.first_seen_at
        AND occurrence.error IS NOT NULL
        AND task.state = 'needs_attention'
        AND (${input.occurrenceId ?? null}::uuid IS NULL OR occurrence.id = ${input.occurrenceId ?? null}::uuid)
        AND NOT EXISTS (
          SELECT 1
          FROM notifications.events event
          WHERE event.definition_id = ${definitions.taskNeedsAttention.id}
            AND event.idempotency_key = 'occurrence:' || occurrence.id::text
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ai.chat_task_occurrences newer
          WHERE newer.task_id = occurrence.task_id
            AND newer.state = 'failed'
            AND (newer.completed_at, newer.id) > (occurrence.completed_at, occurrence.id)
        )
      ORDER BY occurrence.completed_at, occurrence.id
      LIMIT ${limit}
    `;

    const locale = await coreSettings.get<string>("app.locale");
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await notifications.send(definitions.taskNeedsAttention, {
          recipient: { userId: candidate.user_id },
          data: { conversationId: candidate.conversation_id, taskId: candidate.task_id, error: candidate.error },
          idempotencyKey: `occurrence:${candidate.occurrence_id}`,
          locale,
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        log.warn("Failed to create scheduled task attention notification", {
          taskId: candidate.task_id,
          occurrenceId: candidate.occurrence_id,
          error: error instanceof Error ? error.message : "Notification creation failed",
        });
      }
    }
    if (failed > 0) throw new Error(`Failed to create ${failed} scheduled task notification(s).`);
    return { scanned: candidates.length, sent, failed };
  };

  const recoverCostAlerts = async (): Promise<AiNotificationRecoverySummary> => {
    const groups = (await getFreeIpaConfig()).groupsAdmin;
    const candidates = await sql<{ id: string; user_id: string; kind: "warning" | "stop"; cost: number; unit: string }[]>`
      SELECT a.id,u.id AS user_id,a.kind,a.cost::float8 AS cost,a.unit FROM ai.cost_alerts a CROSS JOIN auth.users u
      JOIN notifications.definitions d ON d.id=${definitions.backgroundCosts.id}
      WHERE a.created_at>=d.first_seen_at AND (CASE WHEN u.provider='local' THEN u.admin ELSE EXISTS(
        SELECT 1 FROM auth.ipa_user_effective_groups g WHERE g.user_id=u.id AND g.group_name=ANY(${toPgTextArray(groups)}::text[])) END)
      AND NOT EXISTS(SELECT 1 FROM notifications.events e WHERE e.definition_id=d.id AND e.idempotency_key='cost:'||a.id::text||':'||u.id::text)
      ORDER BY a.created_at,a.id,u.id LIMIT ${RECOVERY_BATCH_SIZE}`;
    const locale = await coreSettings.get<string>("app.locale");
    for (const item of candidates)
      await notifications.send(definitions.backgroundCosts, {
        recipient: { userId: item.user_id },
        data: { kind: item.kind, cost: item.cost, unit: item.unit },
        idempotencyKey: `cost:${item.id}:${item.user_id}`,
        locale,
      });
    return { scanned: candidates.length, sent: candidates.length, failed: 0 };
  };

  const recover = async (): Promise<AiNotificationRecoverySummary> => {
    const [completions, tasks, costs] = await Promise.all([recoverCompletions(), recoverTaskAttention(), recoverCostAlerts()]);
    return {
      scanned: completions.scanned + tasks.scanned + costs.scanned,
      sent: completions.sent + tasks.sent + costs.sent,
      failed: completions.failed + tasks.failed + costs.failed,
    };
  };

  return {
    notifyTurnCompleted: (turnId: string): Promise<AiNotificationRecoverySummary> => recoverCompletions({ turnId, limit: 1 }),
    notifyTaskNeedsAttention: (occurrenceId: string): Promise<AiNotificationRecoverySummary> =>
      recoverTaskAttention({ occurrenceId, limit: 1 }),

    start: async (): Promise<void> => {
      if (worker) return;
      try {
        const timezone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "UTC";
        await recoveryScheduler().create({
          id: RECOVERY_SCHEDULE_ID,
          cron: "* * * * *",
          timezone,
          misfire: "latest",
          meta: {
            appId: "core",
            family: "ai:chat",
            label: "Assistant completion notifications",
            source: RECOVERY_SCHEDULE_ID,
            resourceKind: "notification-recovery",
            resourceId: "assistant-turns",
            resourceLabel: "Assistant chats",
            detailHref: "/me/notifications",
          },
          process: async (context) => {
            await trace.withSpan(
              {
                name: "Assistant completion notification recovery",
                source: RECOVERY_SCHEDULE_ID,
                appId: "core",
                category: "schedule",
                kind: "consumer",
                spanKey: trace.syncSpanKey("scheduler", RECOVERY_SCHEDULER_ID, context.runId),
              },
              recover,
              { summarize: (summary) => summary },
            );
          },
        });
        worker = await recoveryScheduler().process();
      } catch (error) {
        worker?.stop();
        await worker?.drain();
        worker = undefined;
        throw error;
      }
    },

    stop: async (): Promise<void> => {
      worker?.stop();
      await worker?.drain();
      worker = undefined;
    },
  } as const;
};
