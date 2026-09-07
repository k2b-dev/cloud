import { i18n } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { type BoundNotificationMap, lazySync, notification } from "@valentinkolb/cloud";
import {
  coreSettings,
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  logger,
  notifications,
  stopRuntimeJobs,
  stopRuntimeResources,
  trace,
} from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { SHORT_ID_REGEX } from "./lib/short-id";
import { hasCurrentMailboxUserPermission } from "./service/collaborators";
import type { CollaborationNotificationKind } from "./service/notification-outbox";
import { mailNotificationTargetHref } from "./service/notification-targets";

const RECOVERY_SCHEDULE_ID = "mail:collaboration-notifications:recover";
const RECOVERY_BATCH_SIZE = 100;
const RUNTIME_DISPATCH_BATCH_SIZE = 1_000;
const RUNTIME_DISPATCH_RESERVATION_SECONDS = 15 * 60;
const STALE_CLAIM_SECONDS = 10 * 60;

const log = logger("mail:collaboration-notifications");
const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });
const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { reminderTitle: "Mail reminder", reminderFallback: "A conversation reminder is due." },
    de: { reminderTitle: "Mail-Erinnerung", reminderFallback: "Eine Erinnerung für eine Unterhaltung ist fällig." },
  },
});
const text = (locale: string) => notificationMessages.resolve([locale]).t;

const publicResourceId = z.string().regex(SHORT_ID_REGEX);
const notificationData = z.object({
  mailboxId: publicResourceId,
  conversationId: publicResourceId,
  sourceId: publicResourceId,
  subject: z.string(),
});
const workflowNotificationData = z.object({
  mailboxId: publicResourceId,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(2_000),
});

export const NOTIFICATIONS = {
  conversationReminder: notification({
    recipient: "user",
    label: "Mail reminders",
    description: "A notification when one of your conversation reminders is due.",
    presentation: presentation("Mail-Erinnerungen", "Benachrichtigung, wenn eine Erinnerung für eine Unterhaltung fällig ist."),
    delivery: { recommended: ["browser"] },
    data: notificationData,
    render: ({ mailboxId, sourceId, subject }, { locale }) => ({
      title: text(locale).reminderTitle,
      body: subject || text(locale).reminderFallback,
      targetHref: mailNotificationTargetHref({ mailboxId, kind: "reminder", sourceId }),
    }),
  }),
  workflowNotice: notification({
    recipient: "user",
    label: "Mail workflow notifications",
    description: "An internal notification sent by a Mail workflow.",
    presentation: presentation("Mail-Workflow-Benachrichtigungen", "Interne Benachrichtigungen, die ein Mail-Workflow sendet."),
    delivery: { recommended: ["browser"] },
    data: workflowNotificationData,
    render: ({ mailboxId, title, body }) => ({ title, body, targetHref: `/app/mail/${mailboxId}` }),
  }),
};

type MailNotificationDefinitions = BoundNotificationMap<"mail", typeof NOTIFICATIONS>;

type DeliveryRow = {
  id: string;
  kind: CollaborationNotificationKind;
  mailbox_id: string;
  conversation_id: string;
  recipient_user_id: string;
  source_id: string;
  source_revision: string | number;
  attempt: number;
};

export type MailNotificationSendInput = {
  kind: CollaborationNotificationKind;
  recipientUserId: string;
  mailboxId: string;
  conversationId: string;
  sourceId: string;
  subject: string;
  idempotencyKey: string;
  locale?: string;
};

type MailNotificationSender = (input: MailNotificationSendInput) => Promise<void>;

type MailNotificationRecoverySummary = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

type ClaimedDeliveryBatch = {
  claimId: string;
  deliveries: DeliveryRow[];
};

type DeliveryJobInput = { kind: "delivery"; deliveryId: string };

const defaultSender =
  (definitions: MailNotificationDefinitions): MailNotificationSender =>
  async (input) => {
    const data = {
      mailboxId: input.mailboxId,
      conversationId: input.conversationId,
      sourceId: input.sourceId,
      subject: input.subject,
    };
    await notifications.send(definitions.conversationReminder, {
      recipient: { userId: input.recipientUserId },
      data,
      idempotencyKey: input.idempotencyKey,
      locale: input.locale ?? (await coreSettings.get<string>("app.locale")),
    });
  };

const hasCurrentReadAccess = async (delivery: DeliveryRow): Promise<boolean> =>
  hasCurrentMailboxUserPermission({
    mailboxId: delivery.mailbox_id,
    userId: delivery.recipient_user_id,
    minimumPermission: "read",
  });

const loadClaimedDelivery = async (deliveryId: string, claimId: string): Promise<DeliveryRow | null> => {
  const [delivery] = await sql<DeliveryRow[]>`
    SELECT
      id,
      kind,
      mailbox_id,
      conversation_id,
      recipient_user_id,
      source_id,
      source_revision,
      attempt
    FROM mail.collaboration_notification_deliveries
    WHERE id = ${deliveryId}::uuid
      AND state = 'sending'
      AND claim_id = ${claimId}::uuid
  `;
  return delivery ?? null;
};

const loadSendInput = async (delivery: DeliveryRow): Promise<MailNotificationSendInput | null> => {
  if (!(await hasCurrentReadAccess(delivery))) return null;
  const idempotencyKey = `mail:reminder:${delivery.source_id}:${delivery.source_revision}:${delivery.recipient_user_id}`;

  const [row] = await sql<
    {
      mailbox_short_id: string;
      conversation_short_id: string;
      reminder_short_id: string;
      subject: string;
    }[]
  >`
    SELECT
      mailbox.short_id AS mailbox_short_id,
      conversation.short_id AS conversation_short_id,
      reminder.short_id AS reminder_short_id,
      conversation.subject
    FROM mail.conversation_reminders reminder
    JOIN mail.conversations conversation ON conversation.id = reminder.conversation_id
    JOIN mail.mailboxes mailbox ON mailbox.id = reminder.mailbox_id
    WHERE reminder.id = ${delivery.source_id}::uuid
      AND reminder.conversation_id = ${delivery.conversation_id}::uuid
      AND reminder.mailbox_id = ${delivery.mailbox_id}::uuid
      AND reminder.user_id = ${delivery.recipient_user_id}::uuid
      AND reminder.revision = ${delivery.source_revision}
      AND reminder.state = 'pending'
      AND reminder.due_at <= now()
  `;
  return row
    ? {
        kind: "reminder",
        recipientUserId: delivery.recipient_user_id,
        mailboxId: row.mailbox_short_id,
        conversationId: row.conversation_short_id,
        sourceId: row.reminder_short_id,
        subject: row.subject,
        idempotencyKey,
      }
    : null;
};

const skipClaimedDelivery = async (delivery: DeliveryRow, claimId: string): Promise<void> => {
  await sql.begin(async (tx) => {
    if (delivery.kind === "reminder") {
      await tx`
        SELECT id
        FROM mail.conversation_reminders
        WHERE id = ${delivery.source_id}::uuid AND revision = ${delivery.source_revision}
        FOR UPDATE
      `;
    }
    const [updated] = await tx<{ id: string }[]>`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'skipped', claim_id = NULL, claimed_at = NULL, last_error = 'Source or recipient access is no longer current'
      WHERE id = ${delivery.id}::uuid AND state = 'sending' AND claim_id = ${claimId}::uuid
      RETURNING id
    `;
    if (updated && delivery.kind === "reminder") {
      await tx`
        UPDATE mail.conversation_reminders
        SET state = 'canceled', canceled_at = now()
        WHERE id = ${delivery.source_id}::uuid AND revision = ${delivery.source_revision} AND state = 'pending'
      `;
    }
  });
};

const completeClaimedDelivery = async (delivery: DeliveryRow, claimId: string): Promise<void> => {
  await sql.begin(async (tx) => {
    if (delivery.kind === "reminder") {
      await tx`
        SELECT id
        FROM mail.conversation_reminders
        WHERE id = ${delivery.source_id}::uuid AND revision = ${delivery.source_revision}
        FOR UPDATE
      `;
    }
    const [updated] = await tx<{ id: string }[]>`
      UPDATE mail.collaboration_notification_deliveries
      SET state = 'sent', claim_id = NULL, claimed_at = NULL, last_error = NULL, sent_at = now()
      WHERE id = ${delivery.id}::uuid AND state = 'sending' AND claim_id = ${claimId}::uuid
      RETURNING id
    `;
    if (updated && delivery.kind === "reminder") {
      await tx`
        UPDATE mail.conversation_reminders
        SET state = 'sent', sent_at = now()
        WHERE id = ${delivery.source_id}::uuid AND revision = ${delivery.source_revision} AND state = 'pending'
      `;
    }
  });
};

const retryClaimedDelivery = async (delivery: DeliveryRow, claimId: string, error: unknown): Promise<void> => {
  const retryDelayMs = Math.min(5 * 60_000, 2 ** Math.min(delivery.attempt, 8) * 1_000);
  await sql`
    UPDATE mail.collaboration_notification_deliveries
    SET state = 'pending',
        claim_id = NULL,
        claimed_at = NULL,
        available_at = now() + (${retryDelayMs}::text || ' milliseconds')::interval,
        last_error = ${error instanceof Error ? error.message.slice(0, 1_000) : "Notification delivery failed"}
    WHERE id = ${delivery.id}::uuid AND state = 'sending' AND claim_id = ${claimId}::uuid
  `;
};

const recoverStaleClaims = async (db: typeof sql = sql): Promise<void> => {
  await db`
    UPDATE mail.collaboration_notification_deliveries
    SET state = 'pending',
        claim_id = NULL,
        claimed_at = NULL,
        available_at = now(),
        last_error = 'Recovered stale delivery claim'
    WHERE state = 'sending'
      AND claimed_at < now() - (${STALE_CLAIM_SECONDS}::text || ' seconds')::interval
  `;
};

const claimDueDeliveryBatch = async (limit: number): Promise<ClaimedDeliveryBatch> => {
  const claimId = crypto.randomUUID();
  const deliveries = await sql.begin(async (tx) => {
    await recoverStaleClaims(tx);
    return tx<DeliveryRow[]>`
      WITH candidates AS (
        SELECT id
        FROM mail.collaboration_notification_deliveries
        WHERE state = 'pending' AND available_at <= now()
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE mail.collaboration_notification_deliveries delivery
      SET state = 'sending', claim_id = ${claimId}::uuid, claimed_at = now(), attempt = delivery.attempt + 1
      FROM candidates
      WHERE delivery.id = candidates.id
      RETURNING
        delivery.id,
        delivery.kind,
        delivery.mailbox_id,
        delivery.conversation_id,
        delivery.recipient_user_id,
        delivery.source_id,
        delivery.source_revision,
        delivery.attempt
    `;
  });
  return { claimId, deliveries };
};

const reserveDueDeliveryIds = async (limit: number): Promise<string[]> =>
  sql.begin(async (tx) => {
    await recoverStaleClaims(tx);
    const rows = await tx<{ id: string }[]>`
      WITH candidates AS (
        SELECT id
        FROM mail.collaboration_notification_deliveries
        WHERE state = 'pending' AND available_at <= now()
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE mail.collaboration_notification_deliveries delivery
      SET available_at = now() + (${RUNTIME_DISPATCH_RESERVATION_SECONDS}::text || ' seconds')::interval
      FROM candidates
      WHERE delivery.id = candidates.id
      RETURNING delivery.id
    `;
    return rows.map((row) => row.id);
  });

const releaseReservedDelivery = async (deliveryId: string): Promise<void> => {
  await sql`
    UPDATE mail.collaboration_notification_deliveries
    SET available_at = now()
    WHERE id = ${deliveryId}::uuid AND state = 'pending'
  `;
};

const claimReservedDelivery = async (deliveryId: string): Promise<{ claimId: string; delivery: DeliveryRow } | null> => {
  const claimId = crypto.randomUUID();
  const [delivery] = await sql<DeliveryRow[]>`
    UPDATE mail.collaboration_notification_deliveries
    SET state = 'sending', claim_id = ${claimId}::uuid, claimed_at = now(), attempt = attempt + 1
    WHERE id = ${deliveryId}::uuid AND state = 'pending'
    RETURNING id, kind, mailbox_id, conversation_id, recipient_user_id, source_id, source_revision, attempt
  `;
  return delivery ? { claimId, delivery } : null;
};

const deliverClaimedNotification = async (params: {
  delivery: DeliveryRow;
  claimId: string;
  send: MailNotificationSender;
}): Promise<"sent" | "skipped"> => {
  const delivery = await loadClaimedDelivery(params.delivery.id, params.claimId);
  if (!delivery) return "skipped";
  const sendInput = await loadSendInput(delivery);
  if (!sendInput) {
    await skipClaimedDelivery(delivery, params.claimId);
    return "skipped";
  }
  await params.send(sendInput);
  await completeClaimedDelivery(delivery, params.claimId);
  return "sent";
};

export const createMailNotificationService = (
  definitions: MailNotificationDefinitions,
  options: { sender?: MailNotificationSender; jobId?: string } = {},
) => {
  const recoveryScheduler = lazySync((sync) =>
    sync.scheduler({ id: "mail-collaboration-notifications", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
  );

  let recoverySchedulerWorker: Worker | undefined;

  const send = options.sender ?? defaultSender(definitions);
  const deliveryTasks = createRuntimeTaskTracker();
  const deliveryJob = lazySync((sync) =>
    sync.job<DeliveryJobInput>({
      id: options.jobId ?? "mail:collaboration-notification-delivery",
      delivery: { ackWaitMs: 120_000, maxAttempts: 1, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
    }),
  );
  let deliveryJobWorker: Worker | undefined;
  const startDeliveryJob = async (): Promise<void> => {
    deliveryJobWorker = await deliveryJob().process({}, async (ctx) => {
      const spanKey = trace.syncSpanKey("job", options.jobId ?? "mail:collaboration-notification-delivery", ctx.jobId);
      await trace.start({
        name: "Mail collaboration notification delivery",
        source: options.jobId ?? "mail:collaboration-notification-delivery",
        appId: "mail",
        category: "job",
        spanKey,
        attributes: { "cloud.mail.notification_delivery_id": ctx.input.deliveryId },
      });
      const claimed = await claimReservedDelivery(ctx.input.deliveryId);
      if (!claimed) {
        await trace.end({ spanKey, summary: { outcome: "skipped" } });
        return;
      }
      let outcome: Awaited<ReturnType<typeof deliverClaimedNotification>>;
      try {
        outcome = await deliverClaimedNotification({
          delivery: claimed.delivery,
          claimId: claimed.claimId,
          send,
        });
      } catch (error) {
        await retryClaimedDelivery(claimed.delivery, claimed.claimId, error);
        throw error;
      }
      await trace.end({ spanKey, summary: { outcome } });
    });
  };

  const deliveryLifecycle = createRuntimeLifecycle({
    start: async () => {
      deliveryTasks.open();
      await startDeliveryJob();
    },
    stop: async () => {
      await stopRuntimeJobs(deliveryTasks, deliveryJobWorker ? [deliveryJobWorker] : []);
    },
  });

  const recover = async (input: { limit?: number } = {}): Promise<MailNotificationRecoverySummary> => {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? RECOVERY_BATCH_SIZE), 1), 1_000);
    const { claimId, deliveries } = await claimDueDeliveryBatch(limit);

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      try {
        const outcome = await deliverClaimedNotification({ delivery, claimId, send });
        if (outcome === "sent") sent += 1;
        else skipped += 1;
      } catch (error) {
        await retryClaimedDelivery(delivery, claimId, error);
        failed += 1;
        log.warn("Failed to deliver Mail collaboration notification", {
          deliveryId: delivery.id,
          kind: delivery.kind,
          mailboxId: delivery.mailbox_id,
          error: error instanceof Error ? error.message : "Notification delivery failed",
        });
      }
    }
    return { scanned: deliveries.length, sent, skipped, failed };
  };

  const dispatch = async (input: { limit?: number } = {}): Promise<{ reserved: number; enqueued: number }> => {
    await deliveryLifecycle.start();
    const limit = Math.min(Math.max(Math.floor(input.limit ?? RUNTIME_DISPATCH_BATCH_SIZE), 1), RUNTIME_DISPATCH_BATCH_SIZE);
    const deliveryIds = await reserveDueDeliveryIds(limit);
    let enqueued = 0;
    let submitError: unknown = null;
    await Promise.all(
      deliveryIds.map(async (deliveryId) => {
        try {
          const submitted = deliveryTasks.run(() =>
            deliveryJob().submit({ coalesce: true, key: `delivery:${deliveryId}`, input: { kind: "delivery", deliveryId } }),
          );
          if (!submitted) {
            await releaseReservedDelivery(deliveryId);
            return;
          }
          await submitted;
          enqueued += 1;
        } catch (error) {
          await releaseReservedDelivery(deliveryId);
          submitError ??= error;
        }
      }),
    );
    if (submitError) throw submitError;
    return { reserved: deliveryIds.length, enqueued };
  };

  const lifecycle = createRuntimeLifecycle({
    start: async () => {
      await deliveryLifecycle.start();

      const timezone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "Europe/Berlin";

      await recoveryScheduler().create({
        id: RECOVERY_SCHEDULE_ID,
        cron: "* * * * *",
        misfire: "latest",
        timezone: timezone,
        meta: {
          appId: "mail",
          family: "mail:collaboration",
          label: "Mail collaboration notifications",
          source: RECOVERY_SCHEDULE_ID,
          resourceKind: "notification-recovery",
          resourceId: "collaboration",
          resourceLabel: "Mail collaboration",
          detailHref: "/me/notifications",
        },
        process: async (ctx) => {
          const spanKey = trace.syncSpanKey("scheduler", "mail-collaboration-notifications", ctx.runId);
          await trace.start({
            name: "Mail collaboration notification recovery",
            source: "mail-collaboration-notifications",
            appId: "mail",
            category: "schedule",
            spanKey,
          });
          const summary = await dispatch();
          await trace.end({ spanKey, summary });
        },
      });
      recoverySchedulerWorker = await recoveryScheduler().process();
      await recoveryScheduler()
        .runNow({ id: RECOVERY_SCHEDULE_ID, requestId: crypto.randomUUID() })
        .catch((error) => {
          log.warn("Initial Mail collaboration notification recovery failed", {
            error: error instanceof Error ? error.message : "Notification recovery failed",
          });
        });
    },
    stop: async () => {
      await stopRuntimeResources([
        () =>
          recoverySchedulerWorker?.drain().then(() => {
            recoverySchedulerWorker = undefined;
          }),
        () => deliveryLifecycle.stop(),
      ]);
    },
  });

  return {
    recover,
    dispatch,
    start: lifecycle.start,
    stop: async () => {
      await stopRuntimeResources([lifecycle.stop, deliveryLifecycle.stop]);
    },
  } as const;
};
