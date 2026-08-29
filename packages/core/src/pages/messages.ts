import { i18n } from "@k2b/stdlib";

export const corePageMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pageNotFound: "Page not found",
      nothingHere: "Nothing here",
      wrongTurn: "This page does not exist or is no longer available.",
      goHome: "Go to start",
      helpUnavailable: "Help is not currently available.",
      helpTitle: ({ appName }: { appName: string }) => `${appName} help`,
      terms: "Terms of Service",
      privacy: "Privacy Policy",
      imprint: "Imprint",
      legalNotConfigured: ({ title }: { title: string }) => `${title} is not configured. An administrator can add it in`,
    },
    de: {
      pageNotFound: "Seite nicht gefunden",
      nothingHere: "Diese Seite gibt es nicht",
      wrongTurn: "Die Seite ist nicht vorhanden oder nicht mehr verfügbar.",
      goHome: "Zur Startseite",
      helpUnavailable: "Die Hilfe ist derzeit nicht verfügbar.",
      helpTitle: ({ appName }) => `${appName}-Hilfe`,
      terms: "Nutzungsbedingungen",
      privacy: "Datenschutzerklärung",
      imprint: "Impressum",
      legalNotConfigured: ({ title }) => `${title} ist nicht eingerichtet. Die Administration kann den Inhalt hier hinterlegen:`,
    },
  },
});
