import { i18n } from "@k2b/stdlib";

export const queryBlockMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loading: "Loading block preview…",
      failed: "The block preview could not be loaded.",
      savedChanged: "The saved note changed. Reload to update the preview.",
      reload: "Reload",
      headingUnavailable: "Open Book view to navigate to this heading.",
      showSource: "Show source",
      retry: "Retry",
      query: "Note query",
      toc: "Table of contents",
    },
    de: {
      loading: "Blockvorschau wird geladen…",
      failed: "Die Blockvorschau konnte nicht geladen werden.",
      savedChanged: "Die gespeicherte Notiz wurde geändert. Lade die Seite neu, um die Vorschau zu aktualisieren.",
      reload: "Neu laden",
      headingUnavailable: "Öffne die Buchansicht, um zu dieser Überschrift zu springen.",
      showSource: "Quelltext anzeigen",
      retry: "Erneut versuchen",
      query: "Notizabfrage",
      toc: "Inhaltsverzeichnis",
    },
  },
});
