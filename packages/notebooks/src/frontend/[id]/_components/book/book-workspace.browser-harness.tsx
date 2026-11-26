import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
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
          html={
            '<h1 id="ueberblick">Überblick</h1><p>So arbeitet das Lager.</p><p><a href="/app/notebooks/book01/notes/note02?mode=book">Weiter zum Wareneingang</a></p>'
          }
          noteTitle="Überblick"
          canWrite
          locked={false}
          historyIncomplete={false}
          cursor={null}
        />
      </LocaleProvider>
    ),
    root,
  );
}
