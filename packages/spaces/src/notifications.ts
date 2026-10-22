import { type BoundNotificationMap, notification } from "@k2b/cloud";
import { coreSettings, notifications } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Task time blocks reassigned",
      received: "Time blocks moved to you because a task was reassigned.",
      released: "Your time blocks moved to the person now assigned to the task.",
    },
    de: {
      title: "Aufgaben-Zeitblöcke neu zugewiesen",
      received: "Zeitblöcke wurden dir übertragen, weil eine Aufgabe neu zugewiesen wurde.",
      released: "Deine Zeitblöcke wurden der Person übertragen, die jetzt der Aufgabe zugewiesen ist.",
    },
  },
});

export const NOTIFICATIONS = {
  timeBlocksReassigned: notification({
    recipient: "user",
    label: "Reassigned time blocks",
    description: "When task reassignment moves your planned time blocks.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Neu zugewiesene Zeitblöcke",
          description: "Wenn eine neue Aufgabenzuweisung deine Zeitblöcke überträgt.",
        },
      },
    },
    delivery: { recommended: ["browser", "email"] },
    data: z.object({ direction: z.enum(["received", "released"]) }),
    render: ({ direction }, { locale }) => {
      const { t } = messages.resolve([locale]);
      // Notifications deliberately carry no task or Space data: access may change before delivery.
      return { title: t.title, body: t[direction], targetHref: "/app/spaces" };
    },
  }),
};

export type TimeBlockNotificationRow = OutboxRow & {
  recipient_id: string;
  direction: "received" | "released";
};

export const createTimeBlockNotificationOutbox = (definitions: BoundNotificationMap<"spaces", typeof NOTIFICATIONS>) =>
  createPgOutbox<TimeBlockNotificationRow>({
    table: "spaces.time_block_notifications",
    name: "spaces:time-block-notifications",
    orderBy: "recipient_id",
    sequence: "seq",
    reconcileIntervalMs: 30_000,
    publish: async (row) => {
      await notifications.send(definitions.timeBlocksReassigned, {
        recipient: { userId: row.recipient_id },
        data: { direction: row.direction },
        locale: await coreSettings.get<string>("app.locale"),
        idempotencyKey: row.id,
      });
    },
  });
