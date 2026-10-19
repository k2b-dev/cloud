import { i18n } from "@k2b/stdlib";

export const composerOpenMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      appUnavailable: ({ app }: { app: string }) => `${app} is not reachable right now. Choose it again to try once more.`,
      commandsFailed: "Commands from apps could not be loaded",
      tryAgain: "Try again",
    },
    de: {
      appUnavailable: ({ app }) => `${app} ist gerade nicht erreichbar. Erneut wählen versucht es nochmal.`,
      commandsFailed: "Befehle aus Apps konnten nicht geladen werden",
      tryAgain: "Erneut versuchen",
    },
  },
});
