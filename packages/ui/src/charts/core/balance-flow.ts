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
  /** Period used by row/summary helpers; the continuous frame always opens at the newest end. */
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
const balanceFlowBoundaryLabel = (spec: BalanceFlowOptions, index: number): string => {
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

export const balanceFlowColors = {
  balance: "var(--k2b-balance-flow-mark,#3b82f6)",
  in: "var(--k2b-flow-in-mark,#0891b2)",
  out: "var(--k2b-flow-out-mark,#8b5cf6)",
  neutral: "var(--k2b-placeholder-color,#71717a)",
};
/** Common scale and bottom edge make every closing/opening join geometrically identical. */
export function balanceFlowLayout(spec: BalanceFlowOptions) {
  validateBalanceFlow(spec.periods);
  const index = spec.period ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= Math.max(1, spec.periods.length))
    throw new RangeError("Balance flow period is outside the supplied periods.");
  const width = Math.max(620, spec.width ?? 620),
    height = balanceFlowHeight(spec.periods, spec.height);
  const rows = balanceFlowRows(spec, index);
  const nodes: SankeyNode[] = rows.map((n) => ({ id: n.key, label: n.label }));
  const links = rows
    .filter((n) => n.key !== "balance" && n.value !== 0)
    .map((n) => {
      const source = n.direction === "in" || (n.key === "opening" && n.value > 0) || (n.key === "closing" && n.value < 0);
      return { source: source ? n.key : "balance", target: source ? "balance" : n.key, value: Math.abs(n.value) };
    });
  // Reuse the Sankey graph's exact in/out semantics, including balances owed.
  const scene = sankeyLayout({ nodes, links, width, height });
  const bottom = height - 46,
    top = 16;
  const largest = Math.max(1, ...spec.periods.map((_, i) => balanceFlowRows(spec, i).find((r) => r.key === "balance")!.value));
  const gaps = Math.max(1, ...spec.periods.map((p) => Math.max(p.inflows.length, p.outflows.length)));
  const scale = Math.max(0, bottom - top - gaps * 12) / largest;
  const nodeWidth = 8;
  for (const node of scene.nodes) {
    const row = rows[node.index]!;
    node.stage = row.key === "balance" ? 1 : row.direction === "in" || row.key === "opening" ? 0 : 2;
    node.x =
      row.key === "opening"
        ? index > 0
          ? -nodeWidth / 2
          : 0
        : row.key === "closing"
          ? width - (index + 1 < spec.periods.length ? nodeWidth / 2 : nodeWidth)
          : node.stage === 0
            ? 40
            : node.stage === 1
              ? width / 2 - nodeWidth / 2
              : width - 40 - nodeWidth;
    node.height = Math.max(1, Math.abs(row.value) * scale);
    node.y = bottom - node.height;
    node.showLabel = node.value > 0 || row.key === "opening" || row.key === "closing";
  }
  for (const stage of scene.nodes.length ? [0, 2] : []) {
    let cursor = top;
    for (const node of scene.nodes.filter((n) => n.stage === stage && n.id !== "opening" && n.id !== "closing")) {
      node.y = cursor;
      cursor += node.height + 12;
    }
  }
  const labelY = new Map<number, number>();
  for (const stage of [0, 1, 2]) {
    const labels = scene.nodes
      .filter((n) => n.stage === stage && n.showLabel && rows[n.index]!.direction !== "balance")
      .sort((a, b) => a.y - b.y);
    labels.forEach((node, i) =>
      labelY.set(node.index, Math.max(node.y + node.height / 2, i ? labelY.get(labels[i - 1]!.index)! + 36 : top + 12)),
    );
    for (let i = labels.length - 1; i >= 0; i--) {
      const node = labels[i]!;
      labelY.set(
        node.index,
        Math.min(labelY.get(node.index)!, i + 1 < labels.length ? labelY.get(labels[i + 1]!.index)! - 36 : bottom - 24),
      );
    }
  }
  const used = new Map<number, number>();
  const routed = scene.links.map((link) => {
    const source = link.sourceNode,
      target = link.targetNode,
      thickness = Math.max(1, link.value * scale);
    const edgeY = (node: typeof source, other: typeof source) => {
      if (node.id !== "balance") return node.y;
      const side = other.stage === 0 ? 0 : 2;
      const offset = used.get(side) ?? 0;
      used.set(side, offset + thickness);
      return node.y + offset;
    };
    // Put the carry-forward band at the bottom on both sides of the available node.
    const sy = source.id === "balance" && (target.id === "opening" || target.id === "closing") ? bottom - thickness : edgeY(source, target);
    const ty = target.id === "balance" && (source.id === "opening" || source.id === "closing") ? bottom - thickness : edgeY(target, source);
    const forward = source.x < target.x;
    const boundaryX = (node: typeof source) => (node.id === "opening" ? 0 : node.id === "closing" ? width : undefined);
    const x1 = boundaryX(source) ?? source.x + (forward ? nodeWidth : 0),
      x2 = boundaryX(target) ?? target.x + (forward ? 0 : nodeWidth),
      mid = (x1 + x2) / 2;
    return {
      ...link,
      thickness,
      sy,
      ty,
      x1,
      x2,
      path: `M${x1},${sy}C${mid},${sy} ${mid},${ty} ${x2},${ty}L${x2},${ty + thickness}C${mid},${ty + thickness} ${mid},${sy + thickness} ${x1},${sy + thickness}Z`,
    };
  });
  return { ...scene, nodeWidth, links: routed, rows, index, period: spec.periods[index], labelY, scale, bottom };
}
export function renderBalanceFlowSvg(spec: BalanceFlowOptions): string {
  validateBalanceFlow(spec.periods);
  const periodWidth = Math.max(620, spec.width ?? 620),
    width = periodWidth * Math.max(1, spec.periods.length);
  const header = renderHeader(width, spec.title, spec.subtitle);
  const body: string[] = [header.svg.replace(/<text /g, '<text fill="var(--k2b-text,#27272a)" font-size="13" ')];
  const datums = balanceFlowDatums(spec);
  for (const [period] of spec.periods.entries()) {
    const scene = balanceFlowLayout({ ...spec, period });
    const offset = period * periodWidth;
    body.push(
      `<g data-balance-period="${period}" transform="translate(${offset},${header.height})" aria-label="${escapeXml(balanceFlowSummary(spec, period))}">`,
    );
    for (const link of scene.links) {
      const source = scene.rows[link.sourceNode.index]!,
        target = scene.rows[link.targetNode.index]!;
      const direction = source.direction === "neutral" ? target.direction : source.direction;
      body.push(
        `<path class="k2b-balance-flow-band" data-balance-band="${source.key}-${target.key}" fill="${balanceFlowColors[direction]}" fill-opacity="0.24" stroke="none" d="${link.path}"/>`,
      );
    }
    for (const node of scene.nodes) {
      const row = scene.rows[node.index]!;
      if (!node.showLabel || (row.key === "opening" && period > 0)) continue;
      const color = balanceFlowColors[row.direction],
        balance = row.direction === "balance",
        right = node.stage === 2;
      const x = balance
          ? right
            ? scene.width - 20
            : 20
          : node.stage === 1
            ? scene.width / 2
            : node.x + (right ? -12 : scene.nodeWidth + 12),
        y = node.y + node.height / 2;
      const captionY = balance || node.stage === 1 ? scene.bottom + 20 : (scene.labelY.get(node.index) ?? y);
      const leader =
        !balance && node.stage !== 1 && Math.abs(captionY - y) > 1
          ? `<path class="k2b-chart-category-band" d="M${node.x + (right ? 0 : scene.nodeWidth)},${y}L${x},${captionY}" fill="none" stroke="${color}" stroke-width="1"/>`
          : "";
      const captionWidth = node.stage === 1 ? 130 : balance ? 220 : 180;
      // One caption and one inspection target represent both sides of each carry.
      const captionText = balance
        ? `${right ? spec.periods[period]!.label : row.label} · ${balanceFlowDisplayAmount(spec, row)}${right && row.value < 0 ? ` (${balanceFlowWords(spec.locale).balanceOwed})` : ""}`
        : row.label;
      const caption = `<g class="${balance ? "k2b-balance-flow-carry" : "k2b-balance-flow-caption"}" data-balance-caption="${row.key}" fill="var(--k2b-text,#27272a)" font-family="inherit" font-size="12" text-anchor="${node.stage === 1 ? "middle" : right ? "end" : "start"}" stroke="var(--k2b-surface,#fff)" stroke-width="4" paint-order="stroke">${leader}<text x="${x}" y="${captionY - 3}">${escapeXml(fitChartText(captionText, captionWidth, 12))}</text>${balance ? "" : `<text x="${x}" y="${captionY + 14}" font-weight="600" style="font-variant-numeric:tabular-nums">${escapeXml(fitChartText(balanceFlowDisplayAmount(spec, row), captionWidth, 12))}</text>`}</g>`;
      const datum = datums.find((d) => d.seriesIndex === period && d.index === node.index)!;
      body.push(
        chartDatumSvg(
          `<rect data-balance-key="${row.key}" x="${node.x}" y="${node.y}" width="${scene.nodeWidth}" height="${node.height}" rx="0" fill="${color}" fill-opacity="1" stroke="none"/>${caption}`,
          { ...datum, anchor: [node.x + scene.nodeWidth / 2, y] },
          spec.inspect,
        )
          .replace(/<title>[\s\S]*?<\/title>/g, "")
          .replace(
            "<g ",
            `<g role="img" aria-label="${escapeXml([datum.label, ...balanceFlowTooltip(datum, spec.locale).rows.map((field) => `${field.label}: ${field.value}`)].join(" · "))}" `,
          ),
      );
    }
    body.push(
      `<text data-balance-month-text x="16" y="${scene.height - 16}" fill="var(--k2b-text-muted,#71717a)" font-size="12">${escapeXml(spec.periods[period]!.label)}</text></g>`,
    );
  }
  const height = balanceFlowHeight(spec.periods, spec.height) + header.height;
  return svgRoot({ width, height, className: spec.className }, body.join(""))
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(
      "<svg ",
      `<svg data-balance-flow-svg="true" aria-label="${escapeXml(spec.periods.map((_, i) => balanceFlowSummary(spec, i)).join(" "))}" `,
    );
}
