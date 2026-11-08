// One exhaustive kind-switch. Import this module only from lib.ts: the frame
// build replaces that exact specifier and ships the real module separately.
// Scripts and PDF workers get the real renderers synchronously through lib.ts.
import {
  barGauge,
  boxplot,
  gauge,
  histogram,
  renderAreaSvg,
  renderBubbleSvg,
  renderHeatmapSvg,
  renderRadarSvg,
  renderWaterfallSvg,
  scatter,
} from "@k2b/ui/charts/core";
import type { RareChartRenderer } from "./chart-renderer-types";

export const rareChartSvg: RareChartRenderer = (mapped, common) => {
  switch (mapped.kind) {
    case "waterfall":
      return renderWaterfallSvg({ ...mapped, ...common });
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
    case "bubble":
      return renderBubbleSvg({ ...mapped, ...common });
    case "radar":
      return renderRadarSvg({ ...mapped, ...common });
  }
  {
    const unsupported: never = mapped;
    throw new Error(`Unsupported chart: ${String(unsupported)}`);
  }
};

/** Outside app frames every renderer is already available. */
export async function loadChartRenderer(): Promise<void> {}

/** Only the frame stub may defer a drawing. */
export const deferChartDrawing = false;
