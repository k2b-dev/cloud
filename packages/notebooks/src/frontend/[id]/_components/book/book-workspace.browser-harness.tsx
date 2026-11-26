import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { renderNotebookBook } from "@/lib/book-renderer";
import { bookNavigationState } from "../sidebar/sidebar-tree.test-fixture";
import BookWorkspace from "./BookWorkspace";

declare global {
  interface Window {
    /** A marker that a full page load would lose: moving between notes keeps it. */
    bookPageMarker?: string;
  }
}

const tree = [
  {
    id: "note01",
    title: "Überblick",
    children: [
      { id: "note02", title: "Wareneingang", children: [] },
      { id: "note03", title: "Kühlkette", children: [] },
    ],
  },
];
/** A dense page of the handbook, drawn by Book's own renderer: headings, a list, a table and the link onward. */
const OVERVIEW = renderNotebookBook({
  markdown: [
    "# Überblick",
    "So arbeitet das Lager: Ware kommt an Rampe 1 bis 3 an, wird geprüft, eingelagert und für den Versand kommissioniert. Jede Station hat eine eigene Seite mit Ablauf, Ansprechpersonen und Checklisten.",
    "## Stationen",
    "- **Wareneingang** – Annahme, Sichtprüfung, Buchung im System\n- **Einlagerung** – Hochregal Gang A bis F, Kühlbereich K1\n- **Kommissionierung** – Pick-by-Scan, zwei Schichten\n- **Versand** – Packplätze 1 bis 6, Abholung 16 Uhr",
    "## Zeiten",
    "| Bereich | Frühschicht | Spätschicht |\n| --- | --- | --- |\n| Wareneingang | 6:00–14:00 | 14:00–22:00 |\n| Kommissionierung | 6:00–14:00 | 14:00–22:00 |\n| Versand | 8:00–16:30 | – |",
    "[Weiter zum Wareneingang](/app/notebooks/book01/notes/note02?mode=book)",
  ].join("\n\n"),
  notebookId: "book01",
  noteId: "note01",
  locale: "de",
}).html;

const root = document.getElementById("root");
if (root) {
  window.bookPageMarker = "first load";
  render(
    () => (
      <LocaleProvider locale="de">
        <BookWorkspace
          notebookId="book01"
          notebookName="Handbuch Lager"
          notebookIcon={null}
          selectedNoteId="note01"
          navigation={bookNavigationState(tree, "note01")}
          tags={[{ tag: "lager", count: 3 }]}
          currentHref="/app/notebooks/book01/notes/note01?mode=book"
          navigationHidden={false}
          fullWidth={false}
          html={OVERVIEW}
          noteTitle="Überblick"
          // `?reader=1`: a reader, who stays in Book
          canWrite={new URLSearchParams(location.search).get("reader") !== "1"}
          locked={false}
          historyIncomplete={false}
          cursor={null}
        />
      </LocaleProvider>
    ),
    root,
  );
}
