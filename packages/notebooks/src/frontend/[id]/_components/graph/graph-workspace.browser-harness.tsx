import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import { notesContext, sampleNotes } from "../../notes/notes-list.fixture";
import { bigGraph, crossAreaGraph, FIXTURE_NOW, HANDBOOK_IDS, handbookGraph, unlinkedGraph } from "./graph.fixtures";
import NotebookGraphWorkspace from "./NotebookGraphWorkspace.island";
import { parseGraphViewState } from "./view-state";

/** The fixture notebooks by id: the 49-note handbook, 300 notes, notes without links, no notes, and two areas. */
const NOTEBOOKS: Record<string, { name: string; graph: () => NoteGraph; current: string | null }> = {
  hand01: { name: "Handbuch Logistik", graph: handbookGraph, current: HANDBOOK_IDS.wein! },
  big001: { name: "Wissensbasis Standort Nord", graph: bigGraph, current: null },
  free01: { name: "Projekt Hallenumbau", graph: unlinkedGraph, current: null },
  none01: { name: "Leer", graph: () => ({ nodes: [], edges: [] }), current: null },
  pair01: { name: "Zwei Bereiche", graph: crossAreaGraph, current: "regal0" },
};

/** Mounts the graph of the notebook in the address, as the page does: the view comes from the address. */
const mount = () => {
  const root = document.getElementById("root");
  const match = /^\/app\/notebooks\/(\w{6})(?:\/notes\/(\w{6}))?$/.exec(location.pathname);
  const notebook = match ? NOTEBOOKS[match[1]!] : undefined;
  if (!root || !match || !notebook) return;
  const params = new URLSearchParams(location.search);
  const graph = notebook.graph();
  const base = notesContext(sampleNotes(4));
  const ctx = { ...base, notebook: { ...base.notebook, id: match[1]!, name: notebook.name } };
  const locale = params.get("lang") === "de" ? "de" : "en";
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <NotebookGraphWorkspace
          ctx={ctx}
          notebookId={match[1]!}
          notebookName={notebook.name}
          selectedNoteId={match[2] ?? params.get("note") ?? notebook.current ?? graph.nodes[0]?.id ?? null}
          graph={graph}
          view={parseGraphViewState(params)}
          now={FIXTURE_NOW}
          timeZone="Europe/Berlin"
        />
      </LocaleProvider>
    ),
    root,
  );
};
mount();
