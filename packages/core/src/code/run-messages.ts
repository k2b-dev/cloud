import { i18n } from "@k2b/stdlib";

/** Resolve at the UI boundary with the request locale; transport outcomes stay stable codes. */
export const codeRunMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      failed: "Failed",
      rerun: "Run again",
      previousScheduleRunning: "Skipped, previous run is still running",
      lost: "Runner disconnected. Review the recorded calls before running again.",
    },
    de: {
      failed: "Fehlgeschlagen",
      rerun: "Erneut ausführen",
      previousScheduleRunning: "Übersprungen, vorheriger Lauf läuft noch",
      lost: "Runner-Verbindung verloren. Prüfe die gespeicherten Aufrufe vor der erneuten Ausführung.",
    },
  },
});
