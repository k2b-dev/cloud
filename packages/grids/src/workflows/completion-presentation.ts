import { i18n } from "@k2b/stdlib";
import type { WorkflowCompletionItem } from "./contracts";

const deDetailsByStableLabel: Readonly<Record<string, string>> = {
  inputs: "Typisierte Eingaben deklarieren",
  triggers: "Automatische Auslöser deklarieren",
  steps: "Workflow-Schritte deklarieren",
  record: "Ein Datensatz aus einer konfigurierten Tabelle.",
  recordList: "Eine geordnete Liste von Datensätzen aus einer konfigurierten Tabelle.",
  text: "Ein Textwert, der beim Start des Workflows übergeben wird.",
  number: "Ein Zahlenwert, der beim Start des Workflows übergeben wird.",
  boolean: "Ein boolescher Wert, der beim Start des Workflows übergeben wird.",
  date: "Ein Datumswert, der beim Start des Workflows übergeben wird.",
  dateTime: "Ein Datums- und Uhrzeitwert, der beim Start des Workflows übergeben wird.",
  select: "Ein Wert aus einer festen Auswahlliste.",
  schedule: "Startet den Workflow zu künftigen Cron-Zeitpunkten in einer IANA-Zeitzone.",
  recordEvent: "Startet, wenn ein Datensatz erstellt, geändert, gelöscht oder kommentiert wird.",
  closeRecord: "Schließt einen Datensatz gemäß dem aktuellen Tabellenmodus direkt oder über das Vier-Augen-Prinzip ab.",
  createCorrectionDraft: "Erstellt einen verknüpften Folgeentwurf zu einem unveränderten, abgeschlossenen Datensatz derselben Tabelle.",
  finalizeRecord: "Prüft und sperrt einen Datensatz nach einer aktuellen Berechtigungsprüfung dauerhaft.",
  updateRecord: "Ändert Felder eines Datensatzes nach einer aktuellen Berechtigungsprüfung.",
  createRecord: "Erstellt nach einer aktuellen Berechtigungsprüfung einen Datensatz in einer Tabelle.",
  atomicRecords: "Sperrt Datensätze, prüft aktuelle Grids-Daten und schreibt begrenzte Änderungen gemeinsam oder gar nicht.",
  generateDocument: "Erstellt aus einer konfigurierten Vorlage einen unveränderlichen Dokument-Snapshot.",
  createDocumentLink: "Erstellt einen widerrufbaren öffentlichen Download-Link für ein erzeugtes Dokument.",
  sendEmail: "Rendert eine Grids-E-Mail-Vorlage und stellt sie jedem Empfänger genau einmal zu.",
  httpRequest: "Sendet eine explizite JSON-HTTP-Anfrage. Unklare entfernte Ergebnisse werden nicht blind erneut versucht.",
  setVariable: "Speichert einen Wert für spätere Schritte im aktuellen Bereich.",
  succeed: "Beendet den Workflow erfolgreich mit einer für Ausführende bestimmten Meldung.",
  fail: "Beendet den Workflow mit einer für Ausführende bestimmten Fehlermeldung.",
};

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { detail: ({ detail }: { label: string; detail: string }) => detail },
    de: {
      detail: ({ label, detail }) => {
        const translated = deDetailsByStableLabel[label];
        if (translated) return translated;
        if (detail.startsWith("Table ")) return `Tabelle ${detail.slice("Table ".length)}`;
        if (detail.startsWith("Field ")) return `Feld ${detail.slice("Field ".length)}`;
        if (detail === "Document template") return "Dokumentvorlage";
        if (detail === "Email template") return "E-Mail-Vorlage";
        return detail;
      },
    },
  },
});

/** Localizes completion explanations while keeping workflow vocabulary and YAML unchanged. */
export const presentWorkflowCompletions = (items: readonly WorkflowCompletionItem[], locale?: string): WorkflowCompletionItem[] => {
  const { t } = messages.resolve(locale ? [locale] : []);
  return items.map((item) => (item.detail ? { ...item, detail: t.detail({ label: item.label, detail: item.detail }) } : item));
};
