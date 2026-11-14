import type { BarChartOptions, SeriesBarLayout } from "../../content/chart-bar";
import { dotStyle } from "./bar-common";
import { renderSeriesBarLayoutSvg } from "./bar-series";

/** Dot marks extend the prepared bar frame; they never import the bar renderer or layout code. */
export function renderDotMatrixLayoutSvg(
  opts: BarChartOptions & { width: number; height: number; inspect?: boolean },
  g: SeriesBarLayout,
): string {
  return renderSeriesBarLayoutSvg(opts, g, (column) => {
    let marks = "";
    for (const point of column.matrix)
      marks += `<circle class="k2b-chart-dot" data-dot-series="${point.seriesIndex ?? "remainder"}" cx="${point.x}" cy="${point.y}" r="${point.radius}" style="${point.seriesIndex === null ? "fill:var(--k2b-border-strong,#d4d4d8)" : dotStyle(point.seriesIndex, g.entries.length)}" stroke="none" stroke-width="0"/>`;
    return marks;
  });
}
