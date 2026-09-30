import { i18n } from "@k2b/stdlib";
export const quotaText = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Usage",
      summary: ({ value }: { value: string }) => `Usage: ${value}`,
      all: "All models",
      used: "Used",
      unlimited: "Unlimited",
      unavailable: "Not available",
      nearLimit: "almost used up",
      exhausted: "used up",
      resets: ({ when }: { when: string }) => `Resets ${when}`,
      loadFailed: "Usage could not be loaded.",
    },
    de: {
      title: "Nutzung",
      summary: ({ value }) => `Nutzung: ${value}`,
      all: "Alle Modelle",
      used: "Verbraucht",
      unlimited: "Unbegrenzt",
      unavailable: "Nicht verfügbar",
      nearLimit: "fast aufgebraucht",
      exhausted: "aufgebraucht",
      resets: ({ when }) => `Setzt sich ${when} zurück`,
      loadFailed: "Die Nutzung konnte nicht geladen werden.",
    },
  },
});
