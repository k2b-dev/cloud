import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const accountOperationsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      cancel: "Cancel",
      jobStartFailed: "The job could not be started.",
      showLogs: "Show logs",
      run: "Run",
      activity: "Activity & results",
      activityDescription:
        "Review account jobs and their results. Logs open with the relevant sources selected; adjust the time window or search there.",
      allAccountLogs: "Account lifecycle logs",
      syncLogs: "FreeIPA sync logs",
      expiryMaintenance: "Repair account expiry dates",
      expiryWarning:
        "These jobs change expiry dates, including for expired accounts, and may restore their access. They do not assign Linux identities. Review the results in the logs after running a job.",
      forceIpaBackfill: "FreeIPA account expiry",
      startIpaBackfill: "Update FreeIPA expiry dates",
      startingIpaBackfill: "Submitting…",
      ipaBackfillStarted: "FreeIPA expiry maintenance queued. Check the logs for completion.",
      ipaBackfillDescription:
        "Updates missing or premature expiry dates for FreeIPA accounts. Expiry is never set earlier than seven days from now, and a later FreeIPA expiry is not shortened.",
      forceLocalUserBackfill: "Local full account expiry",
      startLocalUserBackfill: "Update local full account expiry dates",
      startingLocalUserBackfill: "Submitting…",
      localUserBackfillStarted: "Local full account expiry maintenance queued. Check the logs for completion.",
      localUserBackfillDescription:
        "Updates missing or premature expiry dates for local full accounts. Expiry is never set earlier than seven days from now.",
      forceLocalGuestBackfill: "Local Guest account expiry",
      startLocalGuestBackfill: "Update Guest expiry dates",
      startingLocalGuestBackfill: "Submitting…",
      localGuestBackfillStarted: "Guest account expiry maintenance queued. Check the logs for completion.",
      localGuestBackfillDescription:
        "Updates missing or premature expiry dates for local guest accounts. Expiry is never set earlier than seven days from now.",
      openScheduledJobs: "Open scheduled jobs",
    },
    de: {
      cancel: "Abbrechen",
      jobStartFailed: "Der Auftrag konnte nicht gestartet werden.",
      showLogs: "Protokolle anzeigen",
      run: "Ausführen",
      activity: "Aktivität & Ergebnisse",
      activityDescription:
        "Account-Aufträge und ihre Ergebnisse prüfen. Die Protokolle öffnen sich mit passenden Quellenfiltern; Zeitraum und Suche lassen sich dort anpassen.",
      allAccountLogs: "Account-Lebenszyklus-Protokolle",
      syncLogs: "FreeIPA-Sync-Protokolle",
      expiryMaintenance: "Account-Ablaufdaten nachpflegen",
      expiryWarning:
        "Diese Aufträge ändern Ablaufdaten, auch bei bereits abgelaufenen Accounts, und können deren Zugang wiederherstellen. Sie weisen keine Linux-Identitäten zu. Prüfe nach dem Ausführen das Ergebnis in den Protokollen.",
      forceIpaBackfill: "Ablaufdaten von FreeIPA-Accounts",
      startIpaBackfill: "FreeIPA-Nachpflege starten",
      startingIpaBackfill: "FreeIPA-Nachpflege wird gestartet…",
      ipaBackfillStarted: "FreeIPA-Nachpflege beauftragt. Den Abschluss findest du in den Protokollen.",
      ipaBackfillDescription:
        "Ergänzt fehlende oder zu frühe Ablaufdaten von FreeIPA-Konten. Das Ablaufdatum wird nie auf weniger als sieben Tage ab jetzt gesetzt; ein späteres FreeIPA-Ablaufdatum wird nicht verkürzt.",
      forceLocalUserBackfill: "Ablaufdaten lokaler Vollaccounts",
      startLocalUserBackfill: "Nachpflege lokaler Benutzer starten",
      startingLocalUserBackfill: "Nachpflege lokaler Benutzer wird gestartet…",
      localUserBackfillStarted: "Nachpflege lokaler Vollaccounts beauftragt. Den Abschluss findest du in den Protokollen.",
      localUserBackfillDescription:
        "Ergänzt fehlende oder zu frühe Ablaufdaten lokaler Vollkonten. Das Ablaufdatum wird nie auf weniger als sieben Tage ab jetzt gesetzt.",
      forceLocalGuestBackfill: "Ablaufdaten lokaler Guest-Accounts",
      startLocalGuestBackfill: "Nachpflege lokaler Gäste starten",
      startingLocalGuestBackfill: "Nachpflege lokaler Gäste wird gestartet…",
      localGuestBackfillStarted: "Nachpflege lokaler Gäste beauftragt. Den Abschluss findest du in den Protokollen.",
      localGuestBackfillDescription:
        "Ergänzt fehlende oder zu frühe Ablaufdaten lokaler Gastkonten. Das Ablaufdatum wird nie auf weniger als sieben Tage ab jetzt gesetzt.",
      openScheduledJobs: "Geplante Aufträge öffnen",
    },
  },
});
export const useOperationMessages = () => {
  const locale = useLocale();
  return () => accountOperationsMessages.resolve([locale()]).t;
};
