import { balanceFlowWords } from "./balance-flow-messages";
import type { BalanceFlowPeriod } from "./balance-flow-size";
import type { ChartOptions } from "./svg-common";
import type { ChartDatum } from "./types";
export type BalanceFlowOptions = ChartOptions & {
  periods: BalanceFlowPeriod[];
  currency: string;
  locale?: string;
  /** Period used by row/summary helpers; the continuous frame always opens at the newest end. */
  period?: number;
  format?: (value: number) => string;
  valueLabel?: string;
  displayWidth?: number;
};
export const balanceFlowAmount = (spec: Pick<BalanceFlowOptions, "locale" | "currency" | "format">, value: number): string =>
  spec.format?.(Math.abs(value)) ?? Math.abs(value).toLocaleString(spec.locale ?? "en", { style: "currency", currency: spec.currency });
export const balanceFlowDisplayAmount = (
  spec: Pick<BalanceFlowOptions, "locale" | "currency" | "format">,
  row: Pick<BalanceFlowRow, "direction" | "value">,
): string => `${row.direction === "in" ? "↙ " : row.direction === "out" ? "↗ " : ""}${balanceFlowAmount(spec, row.value)}`;
export { balanceFlowWords } from "./balance-flow-messages";
export type BalanceFlowRow = { label: string; value: number; direction: "balance" | "in" | "out" | "neutral"; key: string };
export function balanceFlowRows(spec: BalanceFlowOptions, index = spec.period ?? 0): BalanceFlowRow[] {
  const p = spec.periods[index];
  if (!p) return [];
  const t = balanceFlowWords(spec.locale);
  const owed = (label: string, value: number) => (value < 0 ? `${label} (${t.balanceOwed})` : label);
  return [
    { key: "opening", label: owed(t.balanceOpening, p.opening), value: p.opening, direction: "balance" },
    ...p.inflows.map((n, i) => ({ ...n, key: `in-${i}`, direction: "in" as const })),
    {
      key: "balance",
      label: t.balanceAvailable,
      value: Math.max(p.opening, 0) + p.inflows.reduce((s, n) => s + n.value, 0) + Math.max(-p.closing, 0),
      direction: "neutral",
    },
    ...p.outflows.map((n, i) => ({ ...n, key: `out-${i}`, direction: "out" as const })),
    {
      key: "closing",
      label: index + 1 < spec.periods.length ? balanceFlowBoundaryLabel(spec, index) : owed(t.balanceClosing, p.closing),
      value: p.closing,
      direction: "balance",
    },
  ];
}
export const balanceFlowDirection = (direction: string, locale = "en") => {
  const t = balanceFlowWords(locale);
  return direction === "in"
    ? t.balanceInflows
    : direction === "out"
      ? t.balanceOutflows
      : direction === "neutral"
        ? t.balanceAvailable
        : t.balanceBalance;
};
export const balanceFlowSummary = (spec: BalanceFlowOptions, index = spec.period ?? 0): string => {
  const p = spec.periods[index];
  if (!p) return balanceFlowWords(spec.locale).balanceEmpty;
  const t = balanceFlowWords(spec.locale),
    amount = (v: number) => `${balanceFlowAmount(spec, v)}${v < 0 ? ` (${t.balanceOwed})` : ""}`;
  return `${p.label}: ${t.balanceOpening} ${amount(p.opening)}, ${t.balanceInflows} ${amount(p.inflows.reduce((s, n) => s + n.value, 0))}, ${t.balanceOutflows} ${amount(p.outflows.reduce((s, n) => s + n.value, 0))}, ${t.balanceClosing} ${amount(p.closing)}.`;
};
/** Same column order and text as editor chartRows/chartTooltip. */
export function balanceFlowTooltip(datum: ChartDatum, locale = "en") {
  const t = balanceFlowWords(locale);
  return {
    title: datum.label,
    rows: datum.values.map((field) => ({
      label:
        field.label ??
        (field.key === "period" ? t.balancePeriod : field.key === "direction" ? t.balanceDirection : t.chartFields({ key: field.key })),
      value: field.formatted ?? String(field.value),
    })),
  };
}
/** A shared boundary is described once, in the preceding period's closing datum. */
export const balanceFlowBoundaryLabel = (spec: BalanceFlowOptions, index: number): string => {
  const t = balanceFlowWords(spec.locale),
    current = spec.periods[index]!,
    next = spec.periods[index + 1];
  return next
    ? `${t.balanceClosing} ${current.label} = ${t.balanceOpening} ${next.label}${current.closing < 0 ? ` (${t.balanceOwed})` : ""}`
    : t.balanceClosing;
};
/** Full table data includes zero flows, although zero-width links have no inspection target. */
export function balanceFlowDatums(spec: BalanceFlowOptions): ChartDatum[] {
  return spec.periods.flatMap((_, period) =>
    balanceFlowRows(spec, period).map((row, index) => ({
      index,
      seriesIndex: period,
      role: "item" as const,
      label: row.label,
      anchor: [0, 0] as [number, number],
      values: [
        { key: "period", value: spec.periods[period]!.label },
        { key: "direction", value: balanceFlowDirection(row.direction, spec.locale) },
        {
          key: "value",
          value: row.value,
          formatted: balanceFlowDisplayAmount(spec, row),
          ...(spec.valueLabel ? { label: spec.valueLabel } : {}),
        },
      ],
    })),
  );
}
