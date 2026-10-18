import { AppWorkspace } from "@k2b/ui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import NotebookGraph from "../graph/NotebookGraph.island";
import type { GraphViewState } from "../graph/view-state";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";

export type BookGraphFixtureProps = { navigator: BookNavigatorProps; graph: NoteGraph | null; view: GraphViewState; now: string };
type Box = { x: number; width: number; height: number };
declare global {
  interface Window {
    bookGraphLayout?: { before: Box; after: Box };
  }
}

export function BookGraphFixture(props: BookGraphFixtureProps) {
  return (
    <div class="notebook-book-shell">
      <AppWorkspace mobileSurface="flush" class="notebook-book-workspace">
        {createComponent(BookNavigator, props.navigator)}
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            {props.graph ? (
              createComponent(NotebookGraph, {
                notebookId: props.navigator.notebookId,
                notebookName: props.navigator.notebookName,
                selectedNoteId: props.navigator.selectedNoteId,
                graph: props.graph,
                from: "book",
                backHref: props.navigator.graphBack,
                view: props.view,
                now: props.now,
                timeZone: "Europe/Berlin",
                navigationHidden: props.navigator.navigationHidden,
              })
            ) : (
              <article id="notebook-book-content" class="notebook-book-content">
                <h1>Glossary</h1>
                <p>Terms used by our team.</p>
              </article>
            )}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
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
