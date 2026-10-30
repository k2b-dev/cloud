import { i18n } from "@k2b/stdlib";

/** The Workflow AI limit on Cloud administration › Mail; label and description follow the setting declaration. */
export const workflowAiAdminMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      label: "Workflow AI body limit (characters)",
      description:
        "Maximum body characters loaded for an AI step. Changes apply to new work; larger bodies fail visibly without truncation.",
      outOfRange: "Enter a whole number from 1 to 100,000.",
      save: "Save",
      saved: "Workflow AI limit saved.",
      saveFailed: "The limit could not be saved. The previous value still applies.",
      unreadableTitle: "The stored limit cannot be read.",
      unreadableKeep: ({ value }: { value: string }) => `${value} applies for now. Confirm below to replace the stored value.`,
      replaceStored: "Replace stored value",
    },
    de: {
      label: "KI-Workflow-Textgrenze (Zeichen)",
      description:
        "Maximale Textlänge je KI-Schritt. Änderungen gelten für neue Arbeit; längere Texte werden sichtbar abgelehnt und nicht gekürzt.",
      outOfRange: "Gib eine ganze Zahl von 1 bis 100.000 an.",
      save: "Speichern",
      saved: "KI-Workflow-Grenze gespeichert.",
      saveFailed: "Die Grenze konnte nicht gespeichert werden. Es gilt weiter der alte Wert.",
      unreadableTitle: "Die gespeicherte Grenze ist nicht lesbar.",
      unreadableKeep: ({ value }) => `Vorerst gilt ${value}. Bestätige unten, um den gespeicherten Wert zu ersetzen.`,
      replaceStored: "Gespeicherten Wert ersetzen",
    },
  },
});
