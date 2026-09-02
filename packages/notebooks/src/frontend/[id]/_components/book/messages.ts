import { i18n } from "@k2b/stdlib";

export const bookMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      book: "Book",
      write: "Write",
      readonly: "Read-only",
      modes: "Notebook view",
      search: "Search",
      notes: "Pages",
      tags: "Tags",
      allNotebooks: "All notebooks",
      allPages: "All pages",
      empty: "No pages yet",
      selectNote: "Select a page",
      filterEmpty: "No pages match this tag.",
      diagramError: "The diagram could not be displayed. Its source is shown below.",
    },
    de: {
      book: "Buch",
      write: "Bearbeiten",
      readonly: "Schreibgeschützt",
      modes: "Notizbuchansicht",
      search: "Suchen",
      notes: "Seiten",
      tags: "Tags",
      allNotebooks: "Alle Notizbücher",
      allPages: "Alle Seiten",
      empty: "Noch keine Seiten",
      selectNote: "Wähle eine Seite",
      filterEmpty: "Keine Seiten mit diesem Tag.",
      diagramError: "Das Diagramm konnte nicht angezeigt werden. Der Quelltext steht unten.",
    },
  },
});
