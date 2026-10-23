import { i18n } from "@k2b/stdlib";

export const mapMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      notConfigured: "Maps are not set up. The saved places remain available.",
      cloudBudget: ({ reset }: { reset: string }) => `The Cloud map budget is used up until ${reset}.`,
      personBudget: ({ reset }: { reset: string }) => `Your map budget is used up until ${reset}.`,
    },
    de: {
      notConfigured: "Karten sind nicht eingerichtet. Die gespeicherten Orte bleiben verfügbar.",
      cloudBudget: ({ reset }) => `Das Kartenbudget der Cloud ist bis ${reset} aufgebraucht.`,
      personBudget: ({ reset }) => `Dein Kartenbudget ist bis ${reset} aufgebraucht.`,
    },
  },
});
