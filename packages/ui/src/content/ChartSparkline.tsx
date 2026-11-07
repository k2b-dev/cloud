import { mergeProps } from "solid-js";
import { sparkline } from "../charts/core/svg";
import { type ChartProps, renderChartRoot } from "./Chart";
import { responsiveChartSvg } from "./chart-svg";

/** The same chart host and SVG for stat trends, without the catalog dispatcher. */
export function ChartSparkline(props: Omit<Extract<ChartProps, { kind: "sparkline" }>, "kind">) {
  return renderChartRoot(mergeProps(props, { kind: "sparkline" as const }), (options, width, height) => {
    if (options.kind !== "sparkline") throw new Error("Expected sparkline options");
    const { kind: _kind, ...data } = options;
    return responsiveChartSvg(sparkline({ ...data, width, height, inspect: true }));
  });
}
