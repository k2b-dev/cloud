import { calendarTimeLabel, calendarTimeTicks, chartTimeStep, renderLineDetailsSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

/** Portable dates are mapped to UTC; arbitrary-zone callers use the core line facade. */
export const line = (mapped: Extract<RareChart, { kind: "line" }>, common: ChartDrawing, locale?: string): string => {
  const minute = (value: number) => Math.floor(value / 60_000) * 60_000;
  return renderLineDetailsSvg(
    { ...mapped, ...common, locale },
    {
      chartTimeStep,
      chartTimeTicks: (domain, zone, step) => {
        if (zone !== "UTC") throw new RangeError("Portable line time axes use UTC");
        return calendarTimeTicks(domain, zone, step, { wallOf: minute, instantOf: minute });
      },
      chartTimeLabel: (tick, step, axis) => {
        const date = new Date(tick);
        return calendarTimeLabel(tick, step, axis, date.getUTCHours() === 0 && date.getUTCMinutes() === 0);
      },
    },
    (index) => mapped.series[index]?.label ?? "",
  );
};
