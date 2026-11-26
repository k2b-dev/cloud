import { Show } from "solid-js";
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
export default function GraphDisplays(props: { graph: GraphProps; view: GraphView }) {
  const g = () => props.view;
  const t = () => g().t();
  const common = () => ({
    model: g().model,
    notes: g().notes(),
    edges: g().edges(),
    currentId: g().currentId(),
    query: g().query(),
    notebookName: props.graph.notebookName,
    now: props.graph.now,
    filterKey: g().filterKey(),
    onOpen: g().open,
    onClearQuery: () => g().update({ q: "" }),
    controls: g().setControls,
    focusRequest: g().setFocusNote,
    claimFocus: g().claimFocus,
  });
  const network = () => <NetworkDisplay {...common()} displayName={graphDisplayLabel("network", t())} layout={g().networkLayout} />;
  const circle = () => <CircleDisplay {...common()} displayName={graphDisplayLabel("circle", t())} />;
  const neighborhood = () => (
    <NeighborhoodDisplay
      {...common()}
      displayName={graphDisplayLabel("neighborhood", t())}
      depth={g().state().depth}
      onCentre={g().recenter}
      onNetwork={() => g().leaveEmpty({ display: "network" })}
      onResetFilters={g().resetFilters}
      noteHref={g().noteHref}
    />
  );
  return (
    <div class="notebook-graph" data-display={g().display() ?? undefined}>
      <div class="notebook-graph__body">
        <Show
          when={g().display() !== "timeline"}
          fallback={<TimelineDisplay {...common()} timeZone={props.graph.timeZone} noteHref={g().noteHref} />}
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
