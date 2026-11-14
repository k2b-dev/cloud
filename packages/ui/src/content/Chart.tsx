import { type JSX, mergeProps } from "solid-js";
import { chartKinds } from "../charts/core/registry";
import { renderChartSvg } from "../charts/core/render";
import { ChartBalanceFlow } from "./ChartBalanceFlow";
import { type ChartKind, type ChartProps, renderChartRoot } from "./ChartRoot";

export { type ChartRenderOptions, chartRenderHeight, renderChartSvg } from "../charts/core/render";
export type { ChartKind, ChartLabels, ChartProps } from "./ChartRoot";

const ChartRoot = (props: ChartProps) =>
  props.kind === "balanceFlow" ? <ChartBalanceFlow {...props} /> : renderChartRoot(props, renderChartSvg);

type KindProps<T> = T extends unknown ? Omit<T, "kind"> : never;
export type ChartKindProps<K extends ChartKind> = KindProps<Extract<ChartProps, { kind: K }>>;

type ChartComponents = {
  [Name in keyof typeof chartKinds]: (props: ChartKindProps<(typeof chartKinds)[Name]>) => JSX.Element;
};

// Add a renderer to charts/core/registry.ts; its key defines the namespace member and discriminator.
// Both entry styles share ChartRoot, preserving the same owner, markup and reactive props.
const chartComponent =
  (kind: ChartKind) =>
  (props: Omit<ChartProps, "kind">): JSX.Element =>
    // Public namespace types correlate each discriminator with its options.
    ChartRoot(mergeProps(props, { kind }) as ChartProps);
const createChart = () => {
  const components = Object.fromEntries(
    Object.entries(chartKinds).map(([name, kind]) => [name, chartComponent(kind)]),
  ) as unknown as ChartComponents;
  return Object.assign(ChartRoot, components, {
    Calendar: (props: Omit<Extract<ChartProps, { kind: "heatmap"; layout: "calendar" }>, "kind" | "layout">) =>
      ChartRoot(mergeProps(props, { kind: "heatmap" as const, layout: "calendar" as const })),
  });
};
const Chart = /* @__PURE__ */ createChart();
export default Chart;
