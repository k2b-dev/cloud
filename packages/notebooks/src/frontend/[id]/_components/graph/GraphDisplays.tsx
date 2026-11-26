import { type JSX, Show } from "solid-js";
import CircleDisplay from "./CircleDisplay";
import type { GraphProps, GraphView } from "./graph-controller";
import { graphDisplayLabel } from "./graph-displays";
import NeighborhoodDisplay from "./NeighborhoodDisplay";
import NetworkDisplay from "./NetworkDisplay";
import TimelineDisplay from "./TimelineDisplay";
import { DEFAULT_GRAPH_DISPLAY, PHONE_GRAPH_DISPLAY } from "./view-state";

/**
 * The chosen display of the graph, in the graph's own surface (its area colours and current-note accent come from
 * `.notebook-graph`). Before the browser knows the width, both device defaults render and the stylesheet shows one,
 * so the server's picture and the first client picture are the same.
 */
export default function GraphDisplays(props: {
  graph: GraphProps;
  view: GraphView;
  /** What stands over the drawing without moving it, such as Book's live-update notice. */
  overlay?: JSX.Element;
  /** Hands the focus to the way out that replaces Umgebung when a new centre has no visible links. */
  focusEmpty: () => void;
  /** What stands in Umgebung's place around a note without visible links: the frame's way out. */
  neighborhoodEmpty: JSX.Element;
}) {
  const g = () => props.view;
  const t = () => g().t();
  // Getters, so each display reads what it needs when it needs it: a spread of plain values would make the chosen
  // display's branch follow the search and draw the display anew on every keystroke (losing zoom and focus).
  const common = {
    get model() {
      return g().model;
    },
    get notes() {
      return g().notes();
    },
    get edges() {
      return g().edges();
    },
    get currentId() {
      return g().currentId();
    },
    get query() {
      return g().query();
    },
    get notebookName() {
      return props.graph.notebookName;
    },
    get now() {
      return props.graph.now;
    },
    get filterKey() {
      return g().filterKey();
    },
    get onOpen() {
      return g().open;
    },
    get onClearQuery() {
      return () => g().update({ q: "" });
    },
    get controls() {
      return g().setControls;
    },
    get focusRequest() {
      return g().setFocusNote;
    },
    get claimFocus() {
      return g().claimFocus;
    },
  };
  const network = () => <NetworkDisplay {...common} displayName={graphDisplayLabel("network", t())} layout={g().networkLayout} />;
  const circle = () => <CircleDisplay {...common} displayName={graphDisplayLabel("circle", t())} />;
  const neighborhood = () => (
    <NeighborhoodDisplay
      {...common}
      displayName={graphDisplayLabel("neighborhood", t())}
      depth={g().state().depth}
      onCentre={g().recenter}
      onNetwork={() => g().leaveEmpty({ display: "network" })}
      onResetFilters={g().resetFilters}
      noteHref={g().noteHref}
      focusEmpty={props.focusEmpty}
      empty={props.neighborhoodEmpty}
    />
  );
  return (
    <div class="notebook-graph" data-display={g().display() ?? undefined}>
      {props.overlay}
      {/* A large notebook draws the pages around one page; the line says so from the first paint, so nothing moves. */}
      <Show when={props.graph.graph.scope}>
        {(scope) => (
          <p class="notebook-graph__scope" role="note">
            <i class="ti ti-zoom-in-area" aria-hidden="true" />
            <span>
              {t().graphScope({
                shown: g().model.notes.length,
                total: scope().total,
                title: g().model.byId.get(scope().around)?.title || t().untitled,
              })}
            </span>
          </p>
        )}
      </Show>
      <div class="notebook-graph__body">
        <Show
          when={g().display() !== "timeline"}
          fallback={<TimelineDisplay {...common} timeZone={props.graph.timeZone} noteHref={g().noteHref} />}
        >
          <Show
            when={g().display() === null}
            fallback={g().display() === "circle" ? circle() : g().display() === "neighborhood" ? neighborhood() : network()}
          >
            <div class="notebook-graph__desktop-default">{DEFAULT_GRAPH_DISPLAY === "network" ? network() : neighborhood()}</div>
            <div class="notebook-graph__phone-default">{PHONE_GRAPH_DISPLAY === "neighborhood" ? neighborhood() : network()}</div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
