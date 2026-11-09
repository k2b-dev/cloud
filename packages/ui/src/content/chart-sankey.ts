import type { ChartInspectionNavigation } from "./chart-inspection-core";

/** Node-first traversal follows the flow while bands remain painted behind nodes. */
export const sankeyInspectionNavigation: ChartInspectionNavigation = {
  order: (entries) => {
    entries.sort((a, b) => a.datum.index - b.datum.index);
  },
  keepScroll: true,
  reveal: (element) => element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }),
};
