import { i18n } from "@k2b/stdlib";

/** Resolve at the UI boundary with the request locale; transport outcomes stay stable codes. */
export const codeRunMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      failed: "Failed",
      rerun: "Run again",
      succeeded: "Succeeded",
      inactive: "Code is no longer active",
      admissionRefused: "The current policy or version approval prevents this run",
      mandateMismatch: "The version mandate is unavailable",
      retryExhausted: "Automatic retry limit reached",
      wallClockLimit: "Run time limit reached",
      memoryLimit: "Runner memory limit reached",
      stalled: "Runner stopped responding",
      resultUnknown: "Call result is unknown. It may have completed.",
      previousScheduleRunning: "Skipped, previous run is still running",
      lost: "Runner disconnected. Review the recorded calls before running again.",
    },
    de: {
      failed: "Fehlgeschlagen",
      rerun: "Erneut ausführen",
      succeeded: "Erfolgreich",
      inactive: "Code ist nicht mehr aktiv",
      admissionRefused: "Die aktuelle Richtlinie oder Versionsfreigabe verhindert diesen Lauf",
      mandateMismatch: "Das Versionsmandat ist nicht verfügbar",
      retryExhausted: "Limit für automatische Wiederholungen erreicht",
      wallClockLimit: "Laufzeitlimit erreicht",
      memoryLimit: "Speicherlimit des Runners erreicht",
      stalled: "Runner antwortet nicht mehr",
      resultUnknown: "Aufrufergebnis ist unbekannt. Der Aufruf könnte abgeschlossen sein.",
      previousScheduleRunning: "Übersprungen, vorheriger Lauf läuft noch",
      lost: "Runner-Verbindung verloren. Prüfe die gespeicherten Aufrufe vor der erneuten Ausführung.",
    },
  },
});
