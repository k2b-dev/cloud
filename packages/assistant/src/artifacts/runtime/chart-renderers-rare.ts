// One exhaustive kind-switch. Runtime consumers import this only from lib.ts:
// the frame build replaces that exact specifier. build-assets enumerates the
// named kind exports and bundles each chart-kind-<kind>.ts independently.
// Scripts and PDF workers get the real renderers synchronously through lib.ts.

import { area } from "./chart-kind-area";
import { barGauge } from "./chart-kind-barGauge";
import { boxplot } from "./chart-kind-boxplot";
import { bubble } from "./chart-kind-bubble";
import { funnel } from "./chart-kind-funnel";
import { gauge } from "./chart-kind-gauge";
import { hbar } from "./chart-kind-hbar";
import { heatmap } from "./chart-kind-heatmap";
import { histogram } from "./chart-kind-histogram";
import { pareto } from "./chart-kind-pareto";
import { radar } from "./chart-kind-radar";
import { scatter } from "./chart-kind-scatter";
import { treemap } from "./chart-kind-treemap";
import { waterfall } from "./chart-kind-waterfall";
import type { RareChartRenderer } from "./chart-renderer-types";

export { area, barGauge, boxplot, bubble, funnel, gauge, hbar, heatmap, histogram, pareto, radar, scatter, treemap, waterfall };

export const rareChartSvg: RareChartRenderer = (mapped, common) => {
  switch (mapped.kind) {
    case "funnel":
      return funnel(mapped, common);
    case "hbar":
      return hbar(mapped, common);
    case "waterfall":
      return waterfall(mapped, common);
    case "area":
      return area(mapped, common);
    case "scatter":
      return scatter(mapped, common);
    case "histogram":
      return histogram(mapped, common);
    case "boxplot":
      return boxplot(mapped, common);
    case "gauge":
      return gauge(mapped, common);
    case "barGauge":
      return barGauge(mapped, common);
    case "heatmap":
      return heatmap(mapped, common);
    case "treemap":
      return treemap(mapped, common);
    case "pareto":
      return pareto(mapped, common);
    case "bubble":
      return bubble(mapped, common);
    case "radar":
      return radar(mapped, common);
  }
  const unsupported: never = mapped;
  throw new Error(`Unsupported chart: ${String(unsupported)}`);
};

/** Outside app frames every renderer is already available. */
export async function loadChartRenderer(_kind: string): Promise<void> {}

/** Only the frame stub may defer a drawing. */
export const deferChartDrawing = false;
