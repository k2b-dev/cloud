import { SegmentedControl, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import type { GraphDisplay } from "./view-state";

type Messages = ReturnType<typeof notebookWorkspaceMessages.resolve>["t"];

/** Every display the graph offers, in switcher order. Device defaults live in view-state. */
export const GRAPH_DISPLAY_REGISTRY: readonly { id: GraphDisplay; icon: string; label: (t: Messages) => string }[] = [
  { id: "network", icon: "ti ti-affiliate", label: (t) => t.graphDisplayNetwork },
  { id: "circle", icon: "ti ti-chart-donut-3", label: (t) => t.graphDisplayCircle },
  { id: "neighborhood", icon: "ti ti-topology-star-3", label: (t) => t.graphDisplayNeighborhood },
  { id: "timeline", icon: "ti ti-timeline", label: (t) => t.graphDisplayTimeline },
];

export const graphDisplayLabel = (id: GraphDisplay, t: Messages): string =>
  (GRAPH_DISPLAY_REGISTRY.find((display) => display.id === id) ?? GRAPH_DISPLAY_REGISTRY[0]!).label(t);

/** The display switcher. With a single registered display there is nothing to choose, so it renders nothing. */
export function GraphDisplaySwitcher(props: { value: GraphDisplay; onChange: (value: GraphDisplay) => void }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <Show when={GRAPH_DISPLAY_REGISTRY.length > 1}>
      <SegmentedControl
        size="sm"
        ariaLabel={t().graphDisplay}
        value={props.value}
        onValueChange={props.onChange}
        options={GRAPH_DISPLAY_REGISTRY.map((display) => ({
          value: display.id,
          icon: display.icon,
          label: <span class="notebook-graph__display-label">{display.label(t())}</span>,
        }))}
      />
    </Show>
  );
}
