import type { notebookWorkspaceMessages } from "../../messages";
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
