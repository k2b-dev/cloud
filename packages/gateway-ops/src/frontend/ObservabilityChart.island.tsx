import { Chart, useLocale } from "@k2b/ui";
import { formatBytes, formatDateTime, formatNumber } from "@k2b/cloud/shared";

/**
 * Hydrating wrapper around `Chart`.
 *
 * `Chart` sizes itself by measuring its container in `onMount` and starts from
 * a hardcoded 480×280 until then. A chart rendered straight into an SSR page
 * never mounts, so it stays at that size no matter what height class it is
 * given — small, letterboxed, and unreadable. Making it an island is what
 * actually lets the ResizeObserver run and the chart fill its box.
 *
 * Island props must be serializable, so axis formatting is passed as a named
 * format rather than a function.
 */

export type ObservabilityChartFormat = "number" | "bytes" | "datetime" | "timeline";

export type ObservabilityChartProps = {
  kind: "line" | "bar" | "donut" | "stateTimeline";
  class?: string;
  /** Optional explicit size override. State timelines size by row count. */
  style?: string;
  /** `line` only. */
  series?: { label?: string; data: { x: number; y: number }[] }[];
  /** `bar` and `donut`. */
  data?: { label: string; value: number }[];
  /** `stateTimeline` — one lane per row, marks positioned on the time axis. */
  rows?: {
    label: string;
    href?: string;
    tooltip?: string;
    intervals: { from: number; to: number; state: string; label?: string; href?: string; tooltip?: string }[];
  }[];
  states?: { state: string; label?: string; color?: string }[];
  domain?: readonly [number, number];
  interactive?: boolean;
  xFormat?: ObservabilityChartFormat;
  yFormat?: ObservabilityChartFormat;
  legend?: boolean;
  area?: boolean;
};

/** Chart axes hand over a raw number, so each shared helper is adapted to that. */
const formatterFor = (format: ObservabilityChartFormat | undefined, locale: string, domain?: readonly [number, number]): ((value: number) => string) => {
  if (format === "bytes") return (value) => formatBytes(value, { locale });
  if (format === "datetime") return (value) => formatDateTime(new Date(value), { locale });
  if (format === "timeline") {
    const span = domain ? Math.abs(domain[1] - domain[0]) : 0;
    const formatter = new Intl.DateTimeFormat(locale, {
      ...(span > 24 * 60 * 60 * 1000 ? { day: "2-digit", month: "short" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    });
    return (value) => formatter.format(new Date(value));
  }
  return (value) => formatNumber(value, { locale });
};

export default function ObservabilityChart(props: ObservabilityChartProps) {
  const locale = useLocale();
  const cls = () => props.class ?? "h-64 text-dimmed";
  const lineDomain = (): readonly [number, number] | undefined => {
    if (props.kind !== "line") return undefined;
    const values = props.series?.flatMap((series) => series.data.map((point) => point.x)).filter(Number.isFinite) ?? [];
    if (values.length === 0) return undefined;
    return values.reduce<readonly [number, number]>(
      ([min, max], value) => [Math.min(min, value), Math.max(max, value)],
      [values[0]!, values[0]!],
    );
  };

  if (props.kind === "line") {
    return (
      <Chart
        kind="line"
        class={cls()}
        series={props.series ?? []}
        xAxis={{ format: formatterFor(props.xFormat, locale(), lineDomain()) }}
        yAxis={{ format: formatterFor(props.yFormat, locale()) }}
        legend={props.legend}
        area={props.area}
        interactive={props.interactive}
      />
    );
  }

  if (props.kind === "stateTimeline") {
    return (
      <Chart
        kind="stateTimeline"
        class={cls()}
        style={props.style}
        rows={props.rows ?? []}
        states={props.states}
        domain={props.domain}
        xAxis={{ format: formatterFor(props.xFormat, locale(), props.domain) }}
        legend={props.legend}
        interactive={props.interactive}
      />
    );
  }

  if (props.kind === "bar") {
    return <Chart kind="bar" class={cls()} data={props.data ?? []} yAxis={{ format: formatterFor(props.yFormat, locale()) }} />;
  }

  return <Chart kind="donut" class={cls()} data={props.data ?? []} legend={props.legend} />;
}
