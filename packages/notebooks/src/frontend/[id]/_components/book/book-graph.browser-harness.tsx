import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import BookGraphWorkspace from "../graph/BookGraphWorkspace.island";
import type { GraphViewState } from "../graph/view-state";
import type { BookNavigatorProps } from "./BookNavigatorBody";

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
    : // the Book page it opens from: until Book itself runs on v2, the same v2 shell without a graph, Links not current
      createComponent(BookGraphWorkspace, {
        navigator: { ...props.navigator, current: undefined },
        notebookId: props.navigator.notebookId,
        notebookName: props.navigator.notebookName,
        selectedNoteId: props.navigator.selectedNoteId,
        graph: null,
        from: "book",
        view: props.view,
        now: props.now,
        timeZone: "Europe/Berlin",
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
