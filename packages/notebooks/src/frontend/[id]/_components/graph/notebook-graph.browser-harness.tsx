import { AppWorkspace } from "@k2b/ui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import BookGraphLive from "../book/BookGraphLive.island";
import BookNavigator, { type BookNavigatorProps } from "../book/BookNavigator.island";
import { bigGraph } from "./graph.fixtures";
import { layoutNetwork } from "./layout-net";
import { buildGraphModel } from "./model";
import NotebookGraph from "./NotebookGraph.island";
import type { GraphViewState } from "./view-state";

type InitialFrame = {
  checked: string | null;
  depth: boolean;
  boxes: (number[] | null)[];
};
export type NotebookGraphFixtureProps = {
  navigator: BookNavigatorProps;
  graph: NoteGraph;
  view: GraphViewState;
  now: string;
  from?: "book";
};

declare global {
  interface Window {
    notebookGraphFixture?: { mounted: boolean; serverFrame: InitialFrame; clientFrame: InitialFrame; layoutMs: () => number };
  }
}

/** The graph beside the Book navigation with its live notice, as BookGraphSurface shows it to readers. */
export function NotebookGraphFixture(props: NotebookGraphFixtureProps) {
  return (
    <div class="notebook-book-shell">
      <AppWorkspace mobileSurface="flush" class="notebook-book-workspace">
        {createComponent(BookNavigator, props.navigator)}
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false} class="relative">
            {createComponent(BookGraphLive, { notebookId: props.navigator.notebookId, bookHref: props.navigator.currentHref })}
            {createComponent(NotebookGraph, {
              notebookId: props.navigator.notebookId,
              notebookName: props.navigator.notebookName,
              selectedNoteId: props.navigator.selectedNoteId,
              graph: props.graph,
              from: props.from,
              backHref: props.navigator.graphBack,
              view: props.view,
              now: props.now,
              navigationHidden: props.navigator.navigationHidden,
            })}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}

if (typeof document !== "undefined" && document.getElementById("graph-props")) {
  const props: NotebookGraphFixtureProps = JSON.parse(document.getElementById("graph-props")!.textContent!);
  const root = document.getElementById("root")!;
  const frame = (): InitialFrame => {
    const visible = (element: Element) => element.getClientRects().length > 0;
    return {
      checked: [...root.querySelectorAll('[aria-label="Display"] [aria-checked="true"]')].find(visible)?.textContent ?? null,
      depth: [...root.querySelectorAll(".notebook-graph__depth")].some(visible),
      boxes: [".notebook-graph__head", ".notebook-graph__filters", ".notebook-graph__body"].map((selector) => {
        const box = root.querySelector(selector)?.getBoundingClientRect();
        return box ? [box.x, box.y, box.width, box.height].map(Math.round) : null;
      }),
    };
  };
  const serverFrame = frame();
  // @k2b/ssr mounts islands with render after clearing their server HTML; keep that seam.
  root.replaceChildren();
  render(() => createComponent(NotebookGraphFixture, props), root);
  window.notebookGraphFixture = {
    mounted: true,
    serverFrame,
    clientFrame: frame(),
    // The layout cost at 300 notes, measured in this engine.
    layoutMs: () => {
      const model = buildGraphModel(bigGraph(), "en");
      const start = performance.now();
      layoutNetwork(model);
      return performance.now() - start;
    },
  };
}
