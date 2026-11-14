import {
  type BalanceFlowOptions,
  balanceFlowDatums,
  balanceFlowDisplayAmount,
  balanceFlowRows,
  balanceFlowSummary,
  balanceFlowTooltip,
  balanceFlowWords,
} from "./balance-flow-data";

export * from "./balance-flow-data";

import { balanceFlowHeight, validateBalanceFlow } from "./balance-flow-size";
import { chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg-common";

/** Conservative proportional-font advances in em, shared by DOM-free SVG label layout.
 * Wide glyphs retain their natural shape; fitting removes whole code points instead of stretching text.
 */
function chartTextWidth(text: string, size: number): number {
  return (
    Array.from(text).reduce(
      (width, glyph) =>
        width +
        (/\s/.test(glyph)
          ? 0.34
          : /[ilI.,:;!|'`]/.test(glyph)
            ? 0.32
            : /[MW@%&]/.test(glyph)
              ? 1
              : /[A-Z0-9]/.test(glyph)
                ? 0.74
                : /[a-zäöüßéèáàóúñç()-]/i.test(glyph)
                  ? 0.64
                  : 1),
      0,
    ) * size
  );
}

function fitChartText(text: string, width: number, size: number): string {
  if (chartTextWidth(text, size) <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length && chartTextWidth(glyphs.join("") + "…", size) > width) glyphs.pop();
  return chartTextWidth("…", size) <= width ? glyphs.join("") + "…" : "";
}

import type { ChartDatum } from "./types";

export {
  BalanceFlowError,
  type BalanceFlowItem,
  type BalanceFlowPeriod,
  balanceFlowHeight,
  validateBalanceFlow,
} from "./balance-flow-size";
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
  if (!Number.isInteger(index) || index < 0 || index >= Math.max(1, spec.periods.length)) throw new RangeError("Invalid period.");
  const width = Math.max(620, spec.width ?? 620),
    height = balanceFlowHeight(spec.periods, spec.height);
  const rows = balanceFlowRows(spec, index);
  const nodes = rows.map((n, index) => ({
    id: n.key,
    index,
    incoming: 0,
    outgoing: 0,
    value: 0,
    stage: 0,
    x: 0,
    y: 0,
    height: 0,
    showLabel: false,
  }));
  const links = rows
    .filter((n) => n.key !== "balance" && n.value !== 0)
    .map((n) => {
      const source = n.direction === "in" || (n.key === "opening" && n.value > 0) || (n.key === "closing" && n.value < 0);
      return { source: source ? n.key : "balance", target: source ? "balance" : n.key, value: Math.abs(n.value) };
    });
  // This reconciled star is acyclic by construction. Keep Sankey node value = max(in, out),
  // without running a general graph layout that every position below would replace.
  const routedLinks = links.map((link) => {
    const sourceNode = nodes.find((n) => n.id === link.source)!;
    const targetNode = nodes.find((n) => n.id === link.target)!;
    sourceNode.outgoing += link.value;
    targetNode.incoming += link.value;
    return { ...link, sourceNode, targetNode };
  });
  for (const node of nodes) node.value = Math.max(node.incoming, node.outgoing);
  const scene = { nodes, links: routedLinks, width, height, header: { height: 0 } };
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
  return { ...scene, nodeWidth, links: routed, rows, labelY, scale, bottom };
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
        `<path class="k2b-balance-flow-band" data-balance-band="${source.key}-${target.key}" fill="${balanceFlowColors[direction]}" fill-opacity="0.24" stroke="none" pointer-events="none" d="${link.path}"/>`,
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
          `<rect data-balance-key="${row.key}" x="${node.x}" y="${node.y}" width="${scene.nodeWidth}" height="${node.height}" fill="${color}" stroke="none"/>${caption}`,
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
    body.push("</g>");
  }
  const height = balanceFlowHeight(spec.periods, spec.height) + header.height;
  return svgRoot({ width, height, className: spec.className }, body.join(""))
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace("<svg ", '<svg data-balance-flow-svg="true" ');
}
