import { type BarChartOptions, seriesBarLayout } from "../../content/chart-bar";
import { renderBarBaseSvg } from "./bar-base-render";
import { renderDotMatrixLayoutSvg } from "./dots";

/** Drawing stays separate from sizing: Chat loads it on first use, while reserving the frame synchronously. */
export const renderBarChartSvg = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }): string => {
  if (opts.series && opts.marks === "dots") return renderDotMatrixLayoutSvg(opts, seriesBarLayout(opts, opts));
  return renderBarBaseSvg(opts);
};
