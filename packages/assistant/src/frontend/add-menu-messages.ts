import { i18n } from "@k2b/stdlib";

/** Copy of the menu behind "+" beside a chat (Feinschliff v3, section 6). */
export const addMenuMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      open: "Open beside",
      result: "Result from this chat",
      resultNone: "No result in this chat yet",
      files: "Files of the chat",
      keysMove: "↑↓ choose · Enter opens",
      keysLetter: "A letter chooses directly",
      keysBack: "Esc back",
      resultsHeading: "Open a result",
      resultsSearch: ({ count }: { count: number }) => `Search ${count} results`,
    },
    de: {
      open: "Daneben öffnen",
      result: "Ergebnis aus diesem Chat",
      resultNone: "Noch kein Ergebnis in diesem Chat",
      files: "Dateien des Chats",
      keysMove: "↑↓ wählen · Enter öffnet",
      keysLetter: "Buchstabe wählt direkt",
      keysBack: "Esc zurück",
      resultsHeading: "Ergebnis öffnen",
      resultsSearch: ({ count }: { count: number }) => `In ${count} Ergebnissen suchen`,
    },
  },
});
