import { i18n } from "@k2b/stdlib";

export const codeDecisionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      open: "Open",
      home: "Home page",
      more: "More pages:",
      loading: "Loading the page link",
      failed: "The page link could not be loaded.",
      retry: "Try again",
    },
    de: {
      open: "Öffnen",
      home: "Startseite",
      more: "Weitere Seiten:",
      loading: "Seitenlink wird geladen",
      failed: "Der Seitenlink konnte nicht geladen werden.",
      retry: "Erneut versuchen",
    },
  },
});
