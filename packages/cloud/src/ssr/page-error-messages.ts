import { i18n } from "@k2b/stdlib";

export const pageErrorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      forbidden: "Access denied",
      forbiddenDescription: "Your account does not have permission to open this page.",
      notFound: "Page not found",
      notFoundDescription: "This page is unavailable or the link is no longer valid.",
      failed: "Could not open this page",
      failedDescription: "Please try again later.",
      home: "Go to home page",
    },
    de: {
      forbidden: "Zugriff verweigert",
      forbiddenDescription: "Dein Konto hat keine Berechtigung, diese Seite zu öffnen.",
      notFound: "Seite nicht gefunden",
      notFoundDescription: "Diese Seite ist nicht verfügbar oder der Link ist nicht mehr gültig.",
      failed: "Seite konnte nicht geöffnet werden",
      failedDescription: "Bitte versuche es später erneut.",
      home: "Zur Startseite",
    },
  },
});
