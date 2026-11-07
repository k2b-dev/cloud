import { resolveChartMessages } from "../../content/chart-message-catalog";
import { type BalanceFlowPeriod, balanceFlowHeight, validateBalanceFlow } from "./balance-flow-size";
import { type SankeyNode, sankeyLayout } from "./sankey";
import { type ChartOptions, chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg";
import { fitChartText } from "./text";
import type { ChartDatum } from "./types";

export {
  BalanceFlowError,
  type BalanceFlowItem,
  type BalanceFlowPeriod,
  balanceFlowHeight,
  validateBalanceFlow,
} from "./balance-flow-size";
export type BalanceFlowOptions = ChartOptions & {
  periods: BalanceFlowPeriod[];
  currency: string;
  locale?: string;
  /** Initial period, zero based. Defaults to the first period on server and browser. */
  period?: number;
  format?: (value: number) => string;
  valueLabel?: string;
  displayWidth?: number;
};
export const balanceFlowAmount = (spec: Pick<BalanceFlowOptions, "locale" | "currency" | "format">, value: number): string =>
  spec.format?.(Math.abs(value)) ??
  new Intl.NumberFormat(spec.locale ?? "en", { style: "currency", currency: spec.currency }).format(Math.abs(value));
export const balanceFlowDisplayAmount = (
  spec: Pick<BalanceFlowOptions, "locale" | "currency" | "format">,
  row: Pick<BalanceFlowRow, "direction" | "value">,
): string => `${row.direction === "in" ? "↙ " : row.direction === "out" ? "↗ " : ""}${balanceFlowAmount(spec, row.value)}`;
export const balanceFlowWords = (locale = "en") => resolveChartMessages(locale);
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
    { key: "closing", label: owed(t.balanceClosing, p.closing), value: p.closing, direction: "balance" },
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
/** Full table data includes zero flows, although zero-width links have no inspection target. */
export function balanceFlowDatums(spec: BalanceFlowOptions): ChartDatum[] {
  return balanceFlowRows(spec).map((row, index) => ({
    index,
    seriesIndex: spec.period ?? 0,
    role: "item",
    label: row.label,
    anchor: [0, 0],
    values: [
      { key: "period", value: spec.periods[spec.period ?? 0]?.label ?? "" },
      { key: "direction", value: balanceFlowDirection(row.direction, spec.locale) },
      {
        key: "value",
        value: row.value,
        formatted: balanceFlowDisplayAmount(spec, row),
        ...(spec.valueLabel ? { label: spec.valueLabel } : {}),
      },
    ],
  }));
}
export const balanceFlowColors = {
  balance: "var(--k2b-balance-flow-mark,#3b82f6)",
  in: "var(--k2b-flow-in-mark,#0891b2)",
  out: "var(--k2b-flow-out-mark,#8b5cf6)",
  neutral: "var(--k2b-placeholder-color,#71717a)",
};
export function balanceFlowLayout(spec: BalanceFlowOptions) {
  validateBalanceFlow(spec.periods);
  const index = spec.period ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= Math.max(1, spec.periods.length))
    throw new RangeError("Balance flow period is outside the supplied periods.");
  const width = Math.max(620, spec.width ?? 620),
    height = balanceFlowHeight(spec.periods, spec.height);
  const p = spec.periods[index];
  const rows = balanceFlowRows(spec, index);
  const data = rows;
  const nodes: SankeyNode[] = data.map((n) => ({ id: n.key, label: n.label }));
  const links = rows
    .filter((n) => n.key !== "balance" && n.value !== 0)
    .map((n) => {
      const source = n.direction === "in" || (n.key === "opening" && n.value > 0) || (n.key === "closing" && n.value < 0);
      return { source: source ? n.key : "balance", target: source ? "balance" : n.key, value: Math.abs(n.value) };
    });
  const scene = sankeyLayout({ nodes, links, width, height, title: spec.title, subtitle: spec.subtitle });
  const labelY = new Map<number, number>();
  // Zero balances have no link but still belong at their opening/closing end.
  for (const node of scene.nodes) {
    const row = rows[node.index]!;
    node.showLabel = node.value > 0 || row.key === "opening" || row.key === "closing";
    if (!node.value && node.showLabel) {
      node.stage = row.key === "opening" ? 0 : 2;
      node.x = node.stage === 0 ? 0 : scene.width - 160;
      node.y = scene.height / 2;
      node.height = 2;
    }
  }
  for (const stage of [0, 1, 2]) {
    const labels = scene.nodes.filter((n) => n.stage === stage && n.showLabel).sort((a, b) => a.y - b.y);
    const top = scene.header.height + 17,
      bottom = scene.legendTop - 18;
    // Move labels, never amounts or bars: small adjacent flows keep a full two-line caption.
    labels.forEach((node, i) =>
      labelY.set(node.index, Math.max(node.y + node.height / 2, i ? labelY.get(labels[i - 1]!.index)! + 36 : top)),
    );
    for (let i = labels.length - 1; i >= 0; i--) {
      const node = labels[i]!;
      labelY.set(node.index, Math.min(labelY.get(node.index)!, i + 1 < labels.length ? labelY.get(labels[i + 1]!.index)! - 36 : bottom));
    }
  }
  return { ...scene, rows: data, index, period: p, labelY };
}
export function renderBalanceFlowSvg(spec: BalanceFlowOptions): string {
  const scene = balanceFlowLayout(spec),
    t = balanceFlowWords(spec.locale);
  const header = renderHeader(scene.width, spec.title, spec.subtitle).svg.replace(
    /<text /g,
    '<text fill="var(--k2b-text,#27272a)" font-size="13" ',
  );
  const body: string[] = [header];
  const datums = balanceFlowDatums(spec);
  for (const link of scene.links) {
    const source = scene.rows[link.sourceNode.index]!,
      target = scene.rows[link.targetNode.index]!;
    const direction = source.direction === "neutral" ? target.direction : source.direction;
    body.push(
      `<path class="k2b-balance-flow-band" fill="${balanceFlowColors[direction]}" fill-opacity="0.24" stroke="none" d="${link.path}"/>`,
    );
  }
  for (const node of scene.nodes) {
    const row = scene.rows[node.index]!;
    if (!node.value && row.key !== "opening" && row.key !== "closing") continue;
    const color = balanceFlowColors[row.direction],
      x = node.x + scene.nodeWidth + 7,
      y = node.y + node.height / 2;
    const captionY = scene.labelY.get(node.index) ?? y;
    const leader =
      node.showLabel && Math.abs(captionY - y) > 1
        ? `<path class="k2b-chart-category-band" d="M${node.x + scene.nodeWidth},${y}L${x - 3},${captionY}" fill="none" stroke="${color}" stroke-width="1"/>`
        : "";
    const captionWidth = Math.min(154, scene.width - x - 2);
    const amount = balanceFlowDisplayAmount(spec, row);
    const caption = node.showLabel
      ? `<g class="k2b-balance-flow-caption" fill="var(--k2b-text,#27272a)" font-family="inherit" font-size="12" stroke="var(--k2b-surface,#fff)" stroke-width="4" paint-order="stroke">${leader}<text x="${x}" y="${captionY - 3}">${escapeXml(fitChartText(row.label, captionWidth, 12))}</text><text x="${x}" y="${captionY + 14}" font-weight="600" style="font-variant-numeric:tabular-nums">${escapeXml(fitChartText(amount, captionWidth, 12))}</text></g>`
      : "";
    body.push(
      chartDatumSvg(
        `<rect data-balance-key="${row.key}" x="${node.x}" y="${node.y}" width="${scene.nodeWidth}" height="${node.height}" rx="2" fill="${color}" stroke="none"/>${caption}`,
        { ...datums[node.index]!, anchor: [node.x + scene.nodeWidth, y] },
        spec.inspect,
      ),
    );
  }
  if (!scene.links.length)
    body.push(
      `<text x="${scene.width / 2}" y="${scene.height / 2}" text-anchor="middle" font-size="13" fill="var(--k2b-text-muted,#71717a)">${escapeXml(t.balanceNoMovements)}</text>`,
    );
  return svgRoot({ width: scene.width, height: scene.height, className: spec.className }, body.join(""))
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(
      "<svg ",
      `<svg data-balance-flow-svg="true" data-period="${scene.index}" aria-label="${escapeXml(balanceFlowSummary(spec))}" `,
    );
}
