import { i18n } from "@k2b/stdlib";

export const pageErrorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      forbidden: "You don't have access to this",
      forbiddenDescription: "Your account does not have permission to open this page.",
      notFound: "This page does not exist",
      notFoundDescription: "It may have been moved or renamed, or the link is out of date.",
      failed: "This page could not open",
      failedDescription: "Please try again in a moment.",
      home: "Go to home page",
      retry: "Try again",
      search: "Search",
    },
    de: {
      forbidden: "Dafür fehlt dir der Zugriff",
      forbiddenDescription: "Dein Konto hat keine Berechtigung, diese Seite zu öffnen.",
      notFound: "Diese Seite gibt es nicht",
      notFoundDescription: "Vielleicht wurde sie verschoben oder umbenannt, oder der Link ist nicht mehr aktuell.",
      failed: "Die Seite konnte nicht geöffnet werden",
      failedDescription: "Bitte versuche es gleich noch einmal.",
      home: "Zur Startseite",
      retry: "Erneut versuchen",
      search: "Suchen",
    },
  },
});
