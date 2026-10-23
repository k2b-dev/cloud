import { i18n } from "@k2b/stdlib";

export const geoUiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      ownEntry: ({ text }: { text: string }) => `Use “${text}” as typed`,
      ownEntryDetail: "You fill in street, postal code, and city yourself",
      noMatch: "No matching address found.",
      noMatchDetail: "Enter it yourself. It is saved exactly as you write it.",
      unavailable: "Suggestions are unavailable right now. You can enter the address yourself.",
      budgetPerson: ({ time }: { time: string }) => `Suggestions are used up for today, back at ${time}.`,
      budgetCloud: ({ date }: { date: string }) => `Suggestions are used up until ${date}.`,
      budgetDetail: "You can enter the address yourself.",
      keyboardHint: "↑↓ choose · Enter accepts",
    },
    de: {
      ownEntry: ({ text }) => `„${text}“ so übernehmen`,
      ownEntryDetail: "Straße, PLZ und Ort trägst du selbst ein",
      noMatch: "Keine passende Adresse gefunden.",
      noMatchDetail: "Trag sie selbst ein. Sie wird so gespeichert, wie du sie schreibst.",
      unavailable: "Vorschläge gerade nicht verfügbar. Du kannst die Adresse selbst eintragen.",
      budgetPerson: ({ time }) => `Vorschläge heute aufgebraucht, ab ${time} Uhr wieder.`,
      budgetCloud: ({ date }) => `Vorschläge bis ${date} aufgebraucht.`,
      budgetDetail: "Du kannst die Adresse selbst eintragen.",
      keyboardHint: "↑↓ wählen · Enter übernehmen",
    },
  },
});
