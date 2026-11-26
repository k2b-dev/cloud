import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import type { BookNavigatorProps } from "../book/BookNavigatorBody";
import BookGraphWorkspace from "./BookGraphWorkspace.island";
import { bigGraph } from "./graph.fixtures";
import { layoutNetwork } from "./layout-net";
import { buildGraphModel } from "./model";
import type { GraphViewState } from "./view-state";

type InitialFrame = {
  checked: string | null;
  timelineRows: (string | null)[];
  timelineGroups: (string | null)[];
  boxes: (number[] | null)[];
};
export type NotebookGraphFixtureProps = {
  navigator: BookNavigatorProps;
  graph: NoteGraph;
  view: GraphViewState;
  now: string;
  timeZone: string;
  from?: "book";
};

declare global {
  interface Window {
    notebookGraphFixture?: {
      mounted: boolean;
      serverFrame: InitialFrame;
      clientFrame: InitialFrame;
      firstFrameMs: number;
      layoutMs: () => number;
    };
  }
}

/** The graph beside the Book navigation with its live notice, as the page shows it to readers (v2). */
export function NotebookGraphFixture(props: NotebookGraphFixtureProps) {
  return createComponent(BookGraphWorkspace, {
    navigator: props.navigator,
    notebookId: props.navigator.notebookId,
    notebookName: props.navigator.notebookName,
    selectedNoteId: props.navigator.selectedNoteId,
    graph: props.graph,
    from: props.from,
    backHref: props.navigator.graphBack,
    view: props.view,
    now: props.now,
    timeZone: props.timeZone,
  });
}

if (typeof document !== "undefined" && document.getElementById("graph-props")) {
  const props: NotebookGraphFixtureProps = JSON.parse(document.getElementById("graph-props")!.textContent!);
  const root = document.getElementById("root")!;
  const frame = (): InitialFrame => {
    const visible = (element: Element) => element.getClientRects().length > 0;
    return {
      checked: [...root.querySelectorAll('[aria-label="Display"] [aria-current="page"]')].find(visible)?.textContent ?? null,
      timelineRows: [...root.querySelectorAll("[data-row]")].map((row) => row.getAttribute("data-row")),
      timelineGroups: [...root.querySelectorAll(".notebook-graph__timeline-group")].map((group) => group.textContent),
      // the workspace head, the pane head (displays, filters, zoom) and the drawing
      boxes: ['[data-k2-workspace] [data-k2-part="Bar"]', '[data-k2-part="Pane"] [data-k2-part="Bar"]', ".notebook-graph__body"].map(
        (selector) => {
          const box = root.querySelector(selector)?.getBoundingClientRect();
          return box ? [box.x, box.y, box.width, box.height].map(Math.round) : null;
        },
      ),
    };
  };
  const serverFrame = frame();
  // @k2b/ssr mounts islands with render after clearing their server HTML; keep that seam.
  root.replaceChildren();
  const started = performance.now();
  render(() => createComponent(NotebookGraphFixture, props), root);
  window.notebookGraphFixture = {
    mounted: true,
    firstFrameMs: performance.now() - started,
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
