import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the notification pages on v2 that the shared Accounts catalog does not have. */
export const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      required: "Required.",
      audienceRequired: "Choose at least one user or group.",
      batches: ({ count }: { count: string }) => `${count} batches`,
      batchesOf: ({ count, total }: { count: string; total: string }) => `${count} of ${total} batches`,
      noMatches: "No batch has this status.",
      loadFailed: "The notification batches could not be loaded.",
      recipientsFailed: "The recipients could not be loaded. The batch itself is unchanged.",
      noRecipientMatches: "No recipient has this status.",
      notification: "Notification",
      status: "Status",
      sentOf: ({ sent, total }: { sent: string; total: string }) => `${sent} of ${total} sent`,
      errorsCount: ({ count }: { count: string }) => `${count} errors`,
      moreActions: "More actions",
      finalizeQuestion: "Send this notification?",
      sentToast: "Delivery started.",
      retriedToast: "Failed recipients are sent again.",
      recipientRetriedToast: ({ name }: { name: string }) => `${name} is sent again.`,
    },
    de: {
      required: "Pflichtfeld.",
      audienceRequired: "Wähle mindestens einen Benutzer oder eine Gruppe.",
      batches: ({ count }) => `${count} Läufe`,
      batchesOf: ({ count, total }) => `${count} von ${total} Läufen`,
      noMatches: "Kein Lauf hat diesen Status.",
      loadFailed: "Die Benachrichtigungsläufe konnten nicht geladen werden.",
      recipientsFailed: "Die Empfänger konnten nicht geladen werden. Der Lauf selbst ist unverändert.",
      noRecipientMatches: "Kein Empfänger hat diesen Status.",
      notification: "Benachrichtigung",
      status: "Status",
      sentOf: ({ sent, total }) => `${sent} von ${total} gesendet`,
      errorsCount: ({ count }) => `${count} Fehler`,
      moreActions: "Weitere Aktionen",
      finalizeQuestion: "Diese Benachrichtigung senden?",
      sentToast: "Versand gestartet.",
      retriedToast: "Fehlgeschlagene Empfänger werden erneut gesendet.",
      recipientRetriedToast: ({ name }) => `${name} wird erneut gesendet.`,
    },
  },
});

export type NotificationMessages = ReturnType<typeof notificationMessages.resolve>["t"];

export const useNotificationMessages = () => {
  const locale = useLocale();
  return createMemo(() => notificationMessages.resolve([locale()]).t);
};
