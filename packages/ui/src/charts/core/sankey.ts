import { type ChartOptions, chartDatumSvg, escapeXml, svgRoot } from "./svg";

export type SankeyNode = { id: string; label: string; tone?: "in" | "out" | "muted" | "blue" | "green" | "amber" | "red" | "violet" };
export type SankeyLink = { source: string; target: string; value: number };
export type SankeyOptions = ChartOptions & {
  nodes: SankeyNode[];
  links: SankeyLink[];
  legend?: boolean;
  locale?: string;
  format?: (value: number) => string;
  /** Actual host width, when known; defaults to the logical drawing width. */
  displayWidth?: number;
};

/** Shared by JSON validation and direct core calls. Kahn's traversal is linear and never recurses. */
export function sankeyGraph(spec: Pick<SankeyOptions, "nodes" | "links">) {
  const nodes = spec.nodes.map((node, index) => ({ ...node, index, stage: 0, incoming: 0, outgoing: 0, value: 0, edges: [] as number[] }));
  const ids = new Map(nodes.map((node, index) => [node.id, index]));
  if (ids.size !== nodes.length) throw new RangeError("Sankey node ids must be unique.");
  const indegree = nodes.map(() => 0);
  spec.links.forEach((link, index) => {
    const source = ids.get(link.source),
      target = ids.get(link.target);
    if (source === undefined || target === undefined) throw new RangeError("Sankey links must reference existing nodes.");
    if (!Number.isFinite(link.value) || link.value <= 0) throw new RangeError("Sankey link values must be finite and above zero.");
    nodes[source]!.outgoing += link.value;
    nodes[target]!.incoming += link.value;
    nodes[source]!.edges.push(index);
    indegree[target]!++;
  });
  const queue = nodes.filter((node) => indegree[node.index] === 0).map((node) => node.index);
  for (let position = 0; position < queue.length; position++) {
    const node = nodes[queue[position]!]!;
    for (const edge of node.edges) {
      const target = nodes[ids.get(spec.links[edge]!.target)!]!;
      target.stage = Math.max(target.stage, node.stage + 1);
      if (--indegree[target.index]! === 0) queue.push(target.index);
    }
  }
  if (queue.length !== nodes.length) throw new RangeError("Sankey links must not form cycles.");
  for (const node of nodes) {
    node.value = Math.max(node.incoming, node.outgoing);
    if (!Number.isFinite(node.value)) throw new RangeError("Sankey node totals must be finite.");
  }
  return { nodes, ids };
}

export function sankeyLayout(spec: SankeyOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  const { nodes, ids } = sankeyGraph(spec);
  const width = Math.max(620, spec.displayWidth ?? size.width),
    height = size.height;
  const columns = Array.from({ length: Math.max(0, ...nodes.map((node) => node.stage)) + 1 }, (_, stage) =>
    nodes.filter((node) => node.stage === stage),
  );
  const bottom = spec.legend ? 28 : 4,
    top = 4,
    gap = 10,
    nodeWidth = 10,
    labelRoom = 150;
  const scale = Math.min(
    ...columns
      .filter((column) => column.some((node) => node.value > 0))
      .map(
        (column) =>
          Math.max(0, height - top - bottom - gap * Math.max(0, column.length - 1)) / column.reduce((sum, node) => sum + node.value, 0),
      ),
  );
  const ky = Number.isFinite(scale) ? scale : 0;
  const marks = nodes.map((node) => ({
    ...node,
    x: (node.stage * (width - nodeWidth - labelRoom)) / Math.max(1, columns.length - 1),
    y: 0,
    height: node.value * ky,
  }));
  for (const column of columns) {
    const used = column.reduce((sum, node) => sum + node.value * ky, 0) + Math.max(0, column.length - 1) * gap;
    let y = top + (height - top - bottom - used) / 2;
    for (const node of column) {
      marks[node.index]!.y = y;
      y += marks[node.index]!.height + gap;
    }
  }
  const links = spec.links.map((link, index) => ({
    ...link,
    index,
    sourceNode: marks[ids.get(link.source)!]!,
    targetNode: marks[ids.get(link.target)!]!,
    y0: 0,
    y1: 0,
    height: link.value * ky,
  }));
  for (const node of marks) {
    let outgoing = node.y,
      incoming = node.y;
    for (const link of links.filter((link) => link.sourceNode === node).sort((a, b) => a.targetNode.y - b.targetNode.y)) {
      link.y0 = outgoing;
      outgoing += link.height;
    }
    for (const link of links.filter((link) => link.targetNode === node).sort((a, b) => a.sourceNode.y - b.sourceNode.y)) {
      link.y1 = incoming;
      incoming += link.height;
    }
  }
  return { width, height, nodes: marks, links, nodeWidth, scale: ky };
}

const colors = {
  in: "var(--k2b-flow-in-mark,#0891b2)",
  out: "var(--k2b-flow-out-mark,#8b5cf6)",
  muted: "var(--k2b-text-muted,#a1a1aa)",
  blue: "var(--stdlib-chart-c1,#3b82f6)",
  green: "var(--stdlib-chart-c2,#10b981)",
  amber: "var(--stdlib-chart-c3,#f59e0b)",
  violet: "var(--stdlib-chart-c4,#8b5cf6)",
  red: "var(--k2b-danger-text,#b91c1c)",
};
export const sankeyColor = (tone: SankeyNode["tone"]) => colors[tone ?? "blue"];

export function renderSankeySvg(spec: SankeyOptions): string {
  const scene = sankeyLayout(spec);
  const number = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumSignificantDigits: 15 }).format;
  const percent = new Intl.NumberFormat(spec.locale ?? "en", { style: "percent", maximumFractionDigits: 1 });
  const body: string[] = [];
  // Links are painted behind nodes but each inspected datum's first shape carries its own real colour.
  for (const link of scene.links) {
    const x0 = link.sourceNode.x + scene.nodeWidth,
      x1 = link.targetNode.x,
      mid = (x0 + x1) / 2;
    const { y0, y1, height: h } = link;
    body.push(
      chartDatumSvg(
        `<path class="k2b-chart-sankey-link" fill="${sankeyColor(link.sourceNode.tone)}" fill-opacity="0.3" stroke="none" d="M${x0},${y0}C${mid},${y0} ${mid},${y1} ${x1},${y1}L${x1},${y1 + h}C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h}Z"/>`,
        {
          role: "item",
          index: scene.nodes.length + link.index,
          label: `${link.sourceNode.label} → ${link.targetNode.label}`,
          anchor: [mid, (y0 + y1 + h) / 2],
          values: [
            { key: "value", value: link.value, formatted: number(link.value) },
            {
              key: "percent",
              value: (link.value / link.sourceNode.value) * 100,
              formatted: percent.format(link.value / link.sourceNode.value),
            },
          ],
        },
        spec.inspect,
      ),
    );
  }
  for (const node of scene.nodes) {
    body.push(
      chartDatumSvg(
        `<rect x="${node.x}" y="${node.y}" width="${scene.nodeWidth}" height="${node.height}" rx="2" fill="${sankeyColor(node.tone)}" stroke="none"/><text x="${node.x + scene.nodeWidth + 6}" y="${node.y + node.height / 2 + 4}" fill="var(--k2b-text,#27272a)" font-size="12" font-family="inherit" stroke="var(--k2b-surface,#fff)" stroke-width="3" paint-order="stroke">${escapeXml(node.label)} <tspan font-weight="600">${escapeXml(number(node.value))}</tspan></text>`,
        {
          role: "item",
          index: node.index,
          label: node.label,
          anchor: [node.x + scene.nodeWidth, node.y + node.height / 2],
          values: [
            { key: "incoming", value: node.incoming, formatted: number(node.incoming) },
            { key: "outgoing", value: node.outgoing, formatted: number(node.outgoing) },
          ],
        },
        spec.inspect,
      ),
    );
  }
  if (spec.legend) {
    let x = 0;
    for (const node of scene.nodes.filter((node, i, nodes) => nodes.findIndex((other) => other.tone === node.tone) === i)) {
      body.push(
        `<rect x="${x}" y="${scene.height - 16}" width="8" height="8" rx="2" fill="${sankeyColor(node.tone)}"/><text x="${x + 13}" y="${scene.height - 8}" fill="var(--k2b-text,#27272a)" font-size="11">${escapeXml(node.label)}</text>`,
      );
      x += node.label.length * 6 + 30;
    }
  }
  return svgRoot({ ...scene, className: spec.className }, body.join("")).replace("<svg ", '<svg data-chart-scroll="end" ');
}
