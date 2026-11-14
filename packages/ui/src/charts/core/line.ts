/** Dispatch keeps ordinary line drawing independent of opt-in details. */
import { chartTimeLabel, chartTimeStep, chartTimeTicks } from "../../content/chart-time-axis";
import { coreChartMessages } from "./chart-messages";
import { lineBase } from "./line-base";
import { renderLineDetailsSvg } from "./line-details";
import { lineDetailsEnabled } from "./line-options";
import type { LineOptions } from "./svg-common";
export const line = (opts: LineOptions): string => {
  if (!lineDetailsEnabled(opts)) return lineBase(opts);
  return renderLineDetailsSvg(
    opts,
    { chartTimeStep, chartTimeTicks, chartTimeLabel },
    (index) => `${coreChartMessages.resolve([opts.locale ?? "en"]).t.series} ${index + 1}`,
  );
};
