import { type BarChartOptions, renderBarDataSvg, seriesBarLayout } from "../../content/chart-bar";
import { renderSeriesBarLayoutSvg } from "./bar-series";

/** Bar drawing without the optional dot renderer, for small app-frame preludes. */
export const renderBarBaseSvg = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }): string => {
  if (opts.marks === "dots") throw new RangeError("Use the dot renderer");
  if (opts.series) return renderSeriesBarLayoutSvg(opts, seriesBarLayout(opts, opts));
  return renderBarDataSvg(opts);
};
