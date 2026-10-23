import { type BoundNotificationMap, notification } from "@k2b/cloud";
import { coreSettings, notifications } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Task time blocks changed",
      received: "Time blocks moved to you because a task was reassigned.",
      released: "Your time blocks moved to the account now assigned to the task.",
      retained:
        "You are no longer assigned to a task. Its time blocks remain yours because there is no single successor. You can only delete them.",
    },
    de: {
      title: "Aufgaben-Zeitblöcke geändert",
      received: "Zeitblöcke wurden dir übertragen, weil eine Aufgabe neu zugewiesen wurde.",
      released: "Deine Zeitblöcke wurden dem Konto übertragen, das jetzt der Aufgabe zugewiesen ist.",
      retained:
        "Du bist einer Aufgabe nicht mehr zugewiesen. Ihre Zeitblöcke bleiben bei dir, weil es keinen eindeutigen Nachfolger gibt. Du kannst sie nur noch löschen.",
    },
  },
});

export const NOTIFICATIONS = {
  timeBlocksReassigned: notification({
    recipient: "principal",
    label: "Reassigned time blocks",
    description: "When task reassignment transfers or retains your planned time blocks.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Neu zugewiesene Zeitblöcke",
          description: "Wenn eine neue Aufgabenzuweisung deine Zeitblöcke überträgt oder bei dir belässt.",
        },
      },
    },
    delivery: { recommended: ["browser", "email", "inbox"] },
    data: z.object({ direction: z.enum(["received", "released", "retained"]) }),
    render: ({ direction }, { locale }) => {
      const { t } = messages.resolve([locale]);
      // Notifications deliberately carry no task or Space data: access may change before delivery.
      return { title: t.title, body: t[direction], targetHref: "/app/spaces" };
    },
  }),
};

export type TimeBlockNotificationRow = OutboxRow & {
  recipient_id: string | null;
  recipient_service_account_id: string | null;
  recipient_key: string;
  recipient_resource_id: string | null;
  direction: "received" | "released" | "retained";
};

export const createTimeBlockNotificationOutbox = (definitions: BoundNotificationMap<"spaces", typeof NOTIFICATIONS>) =>
  createPgOutbox<TimeBlockNotificationRow>({
    table: "spaces.time_block_notifications",
    name: "spaces:time-block-notifications",
    orderBy: "recipient_key",
    sequence: "seq",
    reconcileIntervalMs: 30_000,
    publish: async (row) => {
      await notifications.send(definitions.timeBlocksReassigned, {
        recipient: row.recipient_id ? { userId: row.recipient_id } : { serviceAccountId: row.recipient_service_account_id! },
        data: { direction: row.direction },
        locale: await coreSettings.get<string>("app.locale"),
        idempotencyKey: row.id,
        ...(row.recipient_resource_id ? { resource: { type: "spaces.space", id: row.recipient_resource_id } } : {}),
      });
    },
  });
