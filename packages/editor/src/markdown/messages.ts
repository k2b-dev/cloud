import { i18n } from "@k2b/stdlib";

export const markdownMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      invalidMermaid: "Invalid Mermaid syntax",
      showErrorDetails: "Show error details",
      loadingDiagram: "Loading diagram...",
    },
    de: {
      invalidMermaid: "Ungültige Mermaid-Syntax",
      showErrorDetails: "Fehlerdetails anzeigen",
      loadingDiagram: "Diagramm wird geladen…",
    },
  },
});
