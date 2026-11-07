// One lazy kind-switch. Script/PDF workers import this synchronously; the frame
// build replaces this module with chart-renderers-frame and ships this separately.
import { barGauge, boxplot, gauge, histogram, renderAreaSvg, renderHeatmapSvg, scatter } from "@k2b/ui/charts/core";
import type { RareChartRenderer } from "./chart-renderer-types";

export const rareChartSvg: RareChartRenderer = (mapped, common) => {
  switch (mapped.kind) {
    case "area":
      return renderAreaSvg({ ...mapped, ...common });
    case "scatter":
      return scatter({ ...mapped, ...common });
    case "histogram":
      return histogram({ ...mapped, ...common });
    case "boxplot":
      return boxplot({ ...mapped, ...common });
    case "gauge":
      return gauge({ ...mapped, ...common });
    case "barGauge":
      return barGauge({ ...mapped, ...common });
    case "heatmap":
      return renderHeatmapSvg({ ...mapped, ...common });
  }
};

/** Outside app frames every renderer is already available. */
export async function loadChartRenderer(): Promise<void> {}
