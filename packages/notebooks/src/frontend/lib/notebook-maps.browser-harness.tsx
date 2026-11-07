import type { GeoDocument } from "@k2b/cloud/geo/document";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { enhanceNotebookMaps } from "./notebook-maps";

const root = document.getElementById("notebook-book-content")!;
const pdf = new URL(location.href).searchParams.has("pdf");
let saved = root.querySelector<HTMLElement>("[data-map-document]")?.dataset.mapDocument ?? "";
window.addEventListener("notebook-map-fixture-restore", () => location.reload());
if (new URL(location.href).searchParams.has("editor")) {
  const { mountMapEditorFixture } = await import("./notebook-maps.editor-harness");
  mountMapEditorFixture(root);
} else if (!pdf) {
  const cleanup = enhanceNotebookMaps(
    root,
    document.documentElement.lang,
    new URL(location.href).searchParams.get("readonly") === "1"
      ? undefined
      : (_previous, next) => {
          if (new URL(location.href).searchParams.get("conflict") === "1") return false;
          saved = JSON.stringify(next);
          localStorage.setItem("fictional-notebook-map", serializeGeoDocument(next));
          document.getElementById("saved")!.textContent = serializeGeoDocument(next);
          return true;
        },
  );
  const initialSearch = new URL(location.href).searchParams.get("search");
  if (initialSearch) {
    const input = root.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (input) {
      input.value = initialSearch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  Object.assign(window, { notebookMapFixture: { saved: (): GeoDocument => JSON.parse(saved), dispose: cleanup } });
}

if (pdf) {
  const { openNotePdfDialog } = await import("../[id]/_components/detail/NotePdfDialog");
  const markdown = JSON.parse(document.getElementById("fixture-markdown")!.textContent!);
  void openNotePdfDialog({ notebookId: "Book01", noteId: "Note01", noteTitle: "Fictional map plan", markdown });
}
