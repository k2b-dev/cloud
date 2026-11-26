import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import BookGraphWorkspace from "../graph/BookGraphWorkspace.island";
import type { GraphViewState } from "../graph/view-state";
import type { BookNavigatorProps } from "./BookNavigatorBody";
import BookPage from "./BookPage";

export type BookGraphFixtureProps = { navigator: BookNavigatorProps; graph: NoteGraph | null; view: GraphViewState; now: string };
type Box = { x: number; width: number; height: number };
declare global {
  interface Window {
    bookGraphLayout?: { before: Box; after: Box };
  }
}

/** Book's graph, or (without a graph) the Book page it opens from, both on v2 as the page shows them. */
export function BookGraphFixture(props: BookGraphFixtureProps) {
  return props.graph
    ? createComponent(BookGraphWorkspace, {
        navigator: props.navigator,
        notebookId: props.navigator.notebookId,
        notebookName: props.navigator.notebookName,
        selectedNoteId: props.navigator.selectedNoteId,
        graph: props.graph,
        from: "book",
        backHref: props.navigator.graphBack,
        view: props.view,
        now: props.now,
        timeZone: "Europe/Berlin",
      })
    : // the Book page it opens from
      createComponent(BookPage, {
        ...props.navigator,
        current: undefined,
        fullWidth: false,
        html: "<h1>Glossary</h1><p>Terms used by our team.</p>",
        noteTitle: "Glossary",
        canWrite: props.navigator.canWrite ?? false,
        locked: props.navigator.locked ?? false,
        historyIncomplete: false,
        cursor: null,
        now: "2026-10-16T17:30:00.000Z",
      });
}

if (typeof document !== "undefined") {
  const props: BookGraphFixtureProps = JSON.parse(document.getElementById("book-props")!.textContent!);
  const root = document.getElementById("root")!;
  const box = (): Box => {
    const rect = root.querySelector(".notebook-sidebar-foot a")!.getBoundingClientRect();
    return { x: rect.x, width: rect.width, height: rect.height };
  };
  // @k2b/ssr mounts islands with render after clearing their server HTML.
  // Keep the same SSR-to-client seam, and record geometry on both sides.
  void document.fonts.ready.then(async () => {
    const before = box();
    root.replaceChildren();
    render(() => createComponent(BookGraphFixture, props), root);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    window.bookGraphLayout = { before, after: box() };
  });
}
