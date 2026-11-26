import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { openNewNotebookDialog } from "../../create-notebook-dialog";
import NotebooksStart from "./NotebooksStart";

const root = document.getElementById("root");
if (root) {
  document.documentElement.lang = "de";
  if (new URL(window.location.href).searchParams.has("switcher"))
    // a notebook page that is not v2 yet: its switcher opens the same dialog in a v2 scope of its own
    render(
      () => (
        <button type="button" onClick={() => void openNewNotebookDialog({ kind: "template" }, "de")}>
          Notizbuch aus Vorlage
        </button>
      ),
      root,
    );
  else
    render(
      () => (
        <LocaleProvider locale="de">
          <NotebooksStart
            templates={[
              { id: "meeting", name: "Besprechungen", description: "Protokolle mit Aufgaben und Beschlüssen", icon: "ti ti-users" },
              { id: "handbook", name: "Handbuch", description: "Kapitel, Abläufe und Ansprechpersonen", icon: "ti ti-book" },
            ]}
          />
        </LocaleProvider>
      ),
      root,
    );
}
