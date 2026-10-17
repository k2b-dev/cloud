import { type BoundNotificationMap, lazySync, notification } from "@k2b/cloud";
import { AI_SHORT_ID_PATTERN } from "@k2b/cloud/ai";
import { APPROVALS_PAGE_PATH } from "@k2b/cloud/contracts/approvals";
import { coreSettings, getFreeIpaConfig, logger, notifications, trace } from "@k2b/cloud/services";
import { toPgTextArray } from "@k2b/cloud/services/postgres";
import { i18n } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { z } from "zod";

const RECOVERY_SCHEDULER_ID = "core-ai-notifications";
const RECOVERY_SCHEDULE_ID = "core:ai-notifications:recover";
const RECOVERY_BATCH_SIZE = 100;
// The approvals concept allows one bundled notice per person in this window.
const APPROVAL_NOTICE_WINDOW = "15 minutes";

const log = logger("core:ai-notifications");
const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });
const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      costWarning: "Background AI cost warning",
      costStop: "Background AI stopped",
      costBody: ({ cost, unit }: { cost: string; unit: string }) =>
        `Reference costs over the last 24 hours: ${cost} ${unit}. Review Usage rules and the contributing workflows.`,
      approvalWaiting: ({ count }: { count: number }) => (count === 1 ? "Approval waiting" : `${count} approvals waiting`),
      approvalBody: "An Action waits for your approval. Nothing happens until you decide.",
      approvalEmail: ({ target }: { target: string }) =>
        `An Action waits for your approval. Nothing happens until you decide. Open it at ${target}`,
      responseReady: "Assistant response ready",
      responseFinished: "Your Assistant response has finished.",
      responseEmail: ({ target }: { target: string }) => `Your Assistant response has finished. Open it at ${target}`,
      taskAttention: ({ taskId }: { taskId: string }) => `Routine ${taskId} needs attention`,
    },
    de: {
      costWarning: "Kostenwarnung für Hintergrund-AI",
      costStop: "Hintergrund-AI angehalten",
      costBody: ({ cost, unit }) =>
        `Referenzkosten der letzten 24 Stunden: ${cost} ${unit}. Prüfe die Usage-Regeln und die verursachenden Workflows.`,
      approvalWaiting: ({ count }) => (count === 1 ? "Freigabe wartet" : `${count} Freigaben warten`),
      approvalBody: "Eine Aktion wartet auf deine Freigabe. Bis du entscheidest, passiert nichts.",
      approvalEmail: ({ target }) =>
        `Eine Aktion wartet auf deine Freigabe. Bis du entscheidest, passiert nichts. Öffne sie unter ${target}`,
      responseReady: "Antwort des Assistenten ist bereit",
      responseFinished: "Die Antwort des Assistenten ist fertig.",
      responseEmail: ({ target }) => `Die Antwort des Assistenten ist fertig. Öffne sie unter ${target}`,
      taskAttention: ({ taskId }) => `Routine ${taskId} braucht deine Aufmerksamkeit`,
    },
  },
});
const text = (locale: string) => notificationMessages.resolve([locale]).t;

const absoluteUrl = async (path: string): Promise<string> => {
  const configured = String((await coreSettings.get<string>("app.url")) || "").trim();
  if (!configured) return path;
  let baseUrl = /^https?:\/\//.test(configured) ? configured : `https://${configured}`;
  // A loop, because /\/+$/ backtracks polynomially on a value with many slashes inside.
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return `${baseUrl}${path}`;
};

export const AI_NOTIFICATIONS = {
  approvalWaiting: notification({
    recipient: "user",
    label: "Pending approvals",
    description:
      "A notification when an Action you started outside Cloud's pages, for example in cld or an editor, waits for your approval.",
    presentation: presentation(
      "Wartende Freigaben",
      "Benachrichtigung, wenn eine Aktion, die du außerhalb der Cloud-Seiten gestartet hast, etwa in cld oder einem Editor, auf deine Freigabe wartet.",
    ),
    delivery: { recommended: ["browser"] },
    data: z.object({ count: z.number().int().positive() }),
    render: ({ count }, { locale }) => ({
      title: text(locale).approvalWaiting({ count }),
      body: text(locale).approvalBody,
      targetHref: APPROVALS_PAGE_PATH,
    }),
    email: async ({ count }, { locale }) => ({
      subject: text(locale).approvalWaiting({ count }),
      content: text(locale).approvalEmail({ target: await absoluteUrl(APPROVALS_PAGE_PATH) }),
    }),
  }),
  backgroundCosts: notification({
    recipient: "user",
    label: "Background AI cost alerts",
    description: "Warnings and emergency stops for background inference costs.",
    presentation: presentation("Hintergrund-AI-Kosten", "Kostenwarnungen und Notbremsen für Hintergrund-AI."),
    delivery: { recommended: ["browser"] },
    data: z.object({ kind: z.enum(["warning", "stop"]), cost: z.number(), unit: z.string() }),
    render: (data, { locale }) => ({
      title: data.kind === "stop" ? text(locale).costStop : text(locale).costWarning,
      body: text(locale).costBody({ ...data, cost: data.cost.toLocaleString(locale, { maximumFractionDigits: 6 }) }),
      targetHref: "/admin/settings?tab=ai-quotas&view=rules",
    }),
    email: (data, { locale }) => ({
      subject: data.kind === "stop" ? text(locale).costStop : text(locale).costWarning,
      content: text(locale).costBody({ ...data, cost: data.cost.toLocaleString(locale, { maximumFractionDigits: 6 }) }),
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
    email: async ({ conversationId }, { locale }) => ({
      subject: text(locale).responseReady,
      content: text(locale).responseEmail({
        target: await absoluteUrl(`/app/assistant?conversation=${encodeURIComponent(conversationId)}`),
      }),
    }),
  }),
  taskNeedsAttention: notification({
    recipient: "user",
    label: "Assistant routines",
    description: "A notification when an Assistant routine cannot continue.",
    presentation: presentation("Assistant-Routinen", "Benachrichtigung, wenn eine Assistant-Routine nicht weiterlaufen kann."),
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

  const recoverApprovalWaiting = async (input: { approvalId?: string; limit?: number } = {}): Promise<AiNotificationRecoverySummary> => {
    // One notice per person and window counts all their waiting requests and names the newest, so it never repeats.
    // A request that arrives inside the window waits for the scheduled run after it. A decision made since the newest
    // request was asked means the person is deciding in Cloud already; requests from before registration stay silent.
    const candidates = await sql<{ id: string; user_id: string; count: number }[]>`
      WITH eligible AS MATERIALIZED (
        SELECT r.id,r.approver_user_id,r.created_at FROM approvals.requests r JOIN auth.users u ON u.id=r.approver_user_id
        WHERE r.status='pending' AND r.expires_at > now() AND r.approver_auth_epoch=u.auth_epoch
          AND (${input.approvalId ?? null}::uuid IS NULL OR r.approver_user_id=(
            SELECT approver_user_id FROM approvals.requests WHERE id=${input.approvalId ?? null}::uuid))
          AND EXISTS (SELECT 1 FROM ai.pending_actions p JOIN ai.turns t ON t.id=p.turn_id
            WHERE p.approval_id=r.id AND p.status='pending' AND t.run_config->>'signedInSession' IS NULL)
      ), ranked AS (
        SELECT *,row_number() OVER (PARTITION BY approver_user_id ORDER BY created_at DESC,id DESC) AS position,
          count(*) OVER (PARTITION BY approver_user_id)::int AS count FROM eligible
      )
      SELECT r.id,r.approver_user_id AS user_id,r.count FROM ranked r
      JOIN notifications.definitions d ON d.id=${definitions.approvalWaiting.id}
      WHERE r.position=1 AND r.created_at > d.first_seen_at
        AND NOT EXISTS (SELECT 1 FROM notifications.events e
          WHERE e.definition_id=d.id AND e.recipient_user_id=r.approver_user_id AND e.idempotency_key='approval:'||r.id::text)
        AND NOT EXISTS (SELECT 1 FROM notifications.events e
          WHERE e.definition_id=d.id AND e.recipient_user_id=r.approver_user_id
            AND e.created_at > now() - ${APPROVAL_NOTICE_WINDOW}::interval)
        AND NOT EXISTS (SELECT 1 FROM approvals.requests seen
          WHERE seen.approver_user_id=r.approver_user_id AND seen.decided_at > r.created_at)
      ORDER BY r.created_at,r.id LIMIT ${input.limit ?? RECOVERY_BATCH_SIZE}`;
    const locale = await coreSettings.get<string>("app.locale");
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await notifications.send(definitions.approvalWaiting, {
          recipient: { userId: candidate.user_id },
          data: { count: candidate.count },
          idempotencyKey: `approval:${candidate.id}`,
          locale,
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        log.warn("Failed to create approval waiting notification", {
          approvalId: candidate.id,
          error: error instanceof Error ? error.message : "Notification creation failed",
        });
      }
    }
    if (failed) throw new Error(`Failed to create ${failed} approval waiting notification(s).`);
    return { scanned: candidates.length, sent, failed };
  };

  const recover = async (): Promise<AiNotificationRecoverySummary> => {
    const [completions, tasks, costs, approvals] = await Promise.all([
      recoverCompletions(),
      recoverTaskAttention(),
      recoverCostAlerts(),
      recoverApprovalWaiting(),
    ]);
    return {
      scanned: completions.scanned + tasks.scanned + costs.scanned + approvals.scanned,
      sent: completions.sent + tasks.sent + costs.sent + approvals.sent,
      failed: completions.failed + tasks.failed + costs.failed + approvals.failed,
    };
  };

  return {
    notifyApprovalWaiting: (approvalId: string): Promise<AiNotificationRecoverySummary> => recoverApprovalWaiting({ approvalId, limit: 1 }),
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
