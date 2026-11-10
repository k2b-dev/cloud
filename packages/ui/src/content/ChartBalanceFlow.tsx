import { createEffect, createMemo, type JSX, onCleanup, onMount, splitProps, untrack } from "solid-js";
import type { BalanceFlowOptions } from "../charts/core/balance-flow";
import { type BalanceFlowState, renderBalanceFlowHtml } from "../charts/core/balance-flow-frame";
import type { ChartDatumRef, ChartSelection, ChartTooltipFormatter } from "../charts/core/inspection";
import { useLocale } from "../intl/locale";
import { mountBalanceFlow, selectBalanceFlowDatum } from "./chart-balance-flow";
import { selectedChartSvg } from "./chart-svg";

export type BalanceFlowUiProps = BalanceFlowOptions & {
  class?: string;
  style?: JSX.CSSProperties | string;
  state?: BalanceFlowState;
  selected?: ChartDatumRef | null;
  error?: string;
  onRetry?: () => void;
  view?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  onSelect?: (selection: ChartSelection) => void;
  tooltip?: ChartTooltipFormatter;
};
export function ChartBalanceFlow(props: BalanceFlowUiProps): JSX.Element {
  const locale = useLocale();
  const [, drawing] = splitProps(props, [
    "selected",
    "onSelect",
    "tooltip",
    "state",
    "error",
    "onRetry",
    "view",
    "onViewChange",
    "class",
    "style",
  ]);
  let host: HTMLDivElement | undefined;
  let currentPeriod = Math.max(0, props.periods.length - 1);
  let currentView = props.view ?? "chart";
  const markup = createMemo(() => {
    return selectedChartSvg(
      renderBalanceFlowHtml(
        { ...drawing, period: currentPeriod, locale: props.locale ?? locale() },
        props.state,
        props.error,
        props.view ?? currentView,
        Boolean(props.onRetry),
        false,
      ),
      untrack(() => props.selected),
    );
  });
  let mounted = false,
    cleanup: (() => void) | undefined;
  let enhanced = false;
  const enhance = () => {
    cleanup?.();
    const root = host?.querySelector<HTMLElement>("[data-balance-flow]");
    if (root) {
      if (enhanced) root.dataset.balanceRestore = String(currentPeriod);
      enhanced = true;
      cleanup = mountBalanceFlow(root, {
        locale: props.locale ?? locale(),
        select: props.onSelect,
        tooltip: props.tooltip,
        retry: props.onRetry,
        viewChange: (view) => {
          currentView = view;
          props.onViewChange?.(view);
        },
        periodChange: (index) => {
          currentPeriod = index;
        },
      });
    }
  };
  createEffect(() => {
    markup();
    if (mounted)
      queueMicrotask(() => {
        if (mounted) enhance();
      });
  });
  createEffect(() => {
    const selected = props.selected;
    const root = host?.querySelector<HTMLElement>("[data-balance-flow]");
    if (root && selected !== undefined) selectBalanceFlowDatum(root, selected);
  });
  onMount(() => {
    mounted = true;
    enhance();
  });
  onCleanup(() => {
    mounted = false;
    cleanup?.();
  });
  return <div ref={host} class={props.class} style={props.style} innerHTML={markup()} />;
}
