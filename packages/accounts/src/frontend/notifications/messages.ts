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
      audienceHint: "Search people and groups. Members of chosen groups and of their nested groups get the message too.",
      batches: ({ count }: { count: string }) => `${count} batches`,
      noMatches: "No batch has this status.",
      loadFailed: "The notification batches could not be loaded.",
      recipientsFailed: "The recipients could not be loaded. The batch itself is unchanged.",
      noRecipientMatches: "No recipient has this status.",
      status: "Status",
      sentOf: ({ sent, total }: { sent: string; total: string }) => `${sent} of ${total} sent`,
      errorsCount: ({ count }: { count: string }) => `${count} errors`,
      moreActions: "More actions",
      sentToast: "Delivery started.",
      retriedToast: "Sent again",
      recipientRetriedToast: "Sent again",
      recipientActions: ({ name }: { name: string }) => `Actions for ${name}`,
      attempts: ({ count }: { count: string }) => `${count} attempts`,
    },
    de: {
      required: "Pflichtfeld.",
      audienceRequired: "Wähle mindestens einen Benutzer oder eine Gruppe.",
      audienceHint: "Suche Personen und Gruppen. Mitglieder gewählter Gruppen und ihrer Untergruppen bekommen die Nachricht auch.",
      batches: ({ count }) => `${count} Läufe`,
      noMatches: "Kein Lauf hat diesen Status.",
      loadFailed: "Die Benachrichtigungsläufe konnten nicht geladen werden.",
      recipientsFailed: "Die Empfänger konnten nicht geladen werden. Der Lauf selbst ist unverändert.",
      noRecipientMatches: "Kein Empfänger hat diesen Status.",
      status: "Status",
      sentOf: ({ sent, total }) => `${sent} von ${total} gesendet`,
      errorsCount: ({ count }) => `${count} Fehler`,
      moreActions: "Weitere Aktionen",
      sentToast: "Versand gestartet.",
      retriedToast: "Erneut gesendet",
      recipientRetriedToast: "Erneut gesendet",
      recipientActions: ({ name }) => `Aktionen für ${name}`,
      attempts: ({ count }) => `${count} Versuche`,
    },
  },
});

export type NotificationMessages = ReturnType<typeof notificationMessages.resolve>["t"];

export const useNotificationMessages = () => {
  const locale = useLocale();
  return createMemo(() => notificationMessages.resolve([locale()]).t);
};
