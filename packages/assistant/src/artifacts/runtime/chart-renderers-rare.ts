// One exhaustive kind-switch. Import this module only from lib.ts: the frame
// build replaces that exact specifier and ships the real module separately.
// Scripts and PDF workers get the real renderers synchronously through lib.ts.
import {
  barGauge,
  boxplot,
  gauge,
  histogram,
  renderAreaSvg,
  renderHbarLayoutSvg,
  renderHeatmapSvg,
  renderSankeySvg,
  renderWaterfallLayoutSvg,
  scatter,
} from "@k2b/ui/charts/core";
import type { RareChartRenderer } from "./chart-renderer-types";

export const rareChartSvg: RareChartRenderer = (mapped, common) => {
  switch (mapped.kind) {
    case "hbar":
      if (!common.hbar) throw new Error("Missing hbar layout");
      return renderHbarLayoutSvg({ ...mapped, ...common }, common.hbar);
    case "waterfall":
      if (!common.waterfall) throw new Error("Missing waterfall layout");
      return renderWaterfallLayoutSvg({ ...mapped, ...common }, common.waterfall);
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
    case "sankey":
      return renderSankeySvg({ ...mapped, ...common, displayWidth: common.width });
  }
  const unsupported: never = mapped;
  throw new Error(`Unsupported chart: ${String(unsupported)}`);
};

/** Outside app frames every renderer is already available. */
export async function loadChartRenderer(): Promise<void> {}

/** Only the frame stub may defer a drawing. */
export const deferChartDrawing = false;
