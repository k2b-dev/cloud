import { type ChartOptions, chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg";

export type SankeyNode = {
  id: string;
  label: string;
  tone?: "in" | "out" | "muted" | "blue" | "green" | "amber" | "red" | "violet" | "tax";
};
export type SankeyLink = { source: string; target: string; value: number };
export type SankeyOptions = ChartOptions & {
  nodes: SankeyNode[];
  links: SankeyLink[];
  legend?: { tone: NonNullable<SankeyNode["tone"]>; label: string }[];
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

/** Physical flow width is shared by SVG and its scroll hosts. */
export function sankeyWidth(spec: Pick<SankeyOptions, "nodes" | "links">, width = 480) {
  const { nodes } = sankeyGraph(spec);
  return Math.max(620, Math.max(0, ...nodes.map((node) => node.stage)) * 190 + 160, width);
}

/** A skipped stage has a private slot so a long link cannot pass through another node. */
export function sankeyLayout(spec: SankeyOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  const { nodes, ids } = sankeyGraph(spec);
  const stages = Math.max(0, ...nodes.map((node) => node.stage)) + 1;
  const width = sankeyWidth(spec, spec.displayWidth ?? size.width);
  const header = renderHeader(width, spec.title, spec.subtitle);
  const legend: { tone: NonNullable<SankeyNode["tone"]>; label: string; x: number; row: number }[] = [];
  let lx = 0,
    lr = 0;
  for (const item of spec.legend ?? []) {
    const space = Math.min(width, item.label.length * 12 + 30);
    if (lx && lx + space > width) {
      lx = 0;
      lr++;
    }
    legend.push({ ...item, x: lx, row: lr });
    lx += space;
  }
  const top = header.height + 4,
    bottom = legend.length ? (lr + 1) * 20 + 8 : 4;
  const slots = nodes.map((node) => ({
    stage: node.stage,
    index: node.index,
    value: node.value,
    y: 0,
    height: 0,
    order: node.index,
    virtual: false,
    incoming: [] as number[],
    outgoing: [] as number[],
  }));
  const chains = spec.links.map((link, index) => {
    const source = ids.get(link.source)!,
      target = ids.get(link.target)!;
    const chain = [source];
    for (let stage = nodes[source]!.stage + 1; stage < nodes[target]!.stage; stage++) {
      chain.push(slots.length);
      slots.push({ stage, index: -1, value: link.value, y: 0, height: 0, order: slots.length, virtual: true, incoming: [], outgoing: [] });
    }
    chain.push(target);
    for (const position of chain.slice(0, -1)) slots[position]!.outgoing.push(index);
    for (const position of chain.slice(1)) slots[position]!.incoming.push(index);
    return chain;
  });
  const columns = Array.from({ length: stages }, (_, stage) => slots.filter((slot) => slot.stage === stage));
  // One stable source-barycenter pass reduces crossings without an iterative layout engine.
  for (let stage = 1; stage < stages; stage++) {
    const center = (slot: (typeof slots)[number]) => {
      const parents = slot.incoming.map((edge) => {
        const chain = chains[edge]!;
        return slots[chain[stage - nodes[ids.get(spec.links[edge]!.source)!]!.stage - 1]!]!.order;
      });
      return parents.length ? parents.reduce((sum, n) => sum + n, 0) / parents.length : slot.order;
    };
    columns[stage]!.sort((a, b) => center(a) - center(b) || a.order - b.order);
    columns[stage]!.forEach((slot, index) => {
      slot.order = index;
    });
  }
  const count = Math.max(1, ...columns.map((column) => column.length));
  const minimum = Math.max(
    0,
    ...columns.map((column) => column.reduce((sum, slot) => sum + Math.max(2, slot.incoming.length, slot.outgoing.length), 0)),
  );
  const height = Math.max(size.height, top + bottom + minimum * 1.5);
  const available = height - top - bottom,
    gap = Math.min(10, available / 3 / Math.max(1, count - 1));
  const thickness = (edge: number, scale: number) => Math.max(1, spec.links[edge]!.value * scale);
  const slotHeight = (slot: (typeof slots)[number], scale: number) =>
    Math.max(
      2,
      slot.value * scale,
      slot.incoming.reduce((s, e) => s + thickness(e, scale), 0),
      slot.outgoing.reduce((s, e) => s + thickness(e, scale), 0),
    );
  const fits = (scale: number) =>
    columns.every(
      (column) => column.reduce((s, slot) => s + slotHeight(slot, scale), 0) + Math.max(0, column.length - 1) * gap <= available,
    );
  let lo = 0,
    hi = available / Math.max(1, ...nodes.map((node) => node.value));
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const ky = lo,
    nodeWidth = 10,
    labelRoom = 150;
  const stageX = (stage: number) => (stage * (width - nodeWidth - labelRoom)) / Math.max(1, stages - 1);
  for (const column of columns) {
    const used = column.reduce((s, slot) => s + slotHeight(slot, ky), 0) + Math.max(0, column.length - 1) * gap;
    let y = top + (available - used) / 2;
    for (const slot of column) {
      slot.y = y;
      slot.height = slotHeight(slot, ky);
      y += slot.height + gap;
    }
  }
  const marks = nodes.map((node) => ({
    ...node,
    x: stageX(node.stage),
    y: slots[node.index]!.y,
    height: slots[node.index]!.height,
    showLabel: false,
  }));
  for (const column of columns) {
    let last = -Infinity;
    for (const slot of column) {
      if (slot.virtual) continue;
      const mid = slot.y + slot.height / 2;
      if (mid - last < 15 || column.some((other) => other.virtual && other.y < mid + 8 && other.y + other.height > mid - 8)) continue;
      marks[slot.index]!.showLabel = true;
      last = mid;
    }
  }
  const starts = new Map<string, number>(),
    ends = new Map<string, number>();
  for (const column of columns)
    for (const slot of column) {
      const slotIndex = slots.indexOf(slot);
      let y = slot.y;
      for (const edge of [...slot.outgoing].sort((a, b) => {
        const ca = chains[a]!,
          cb = chains[b]!;
        return slots[ca[ca.indexOf(slotIndex) + 1]!]!.y - slots[cb[cb.indexOf(slotIndex) + 1]!]!.y;
      })) {
        starts.set(`${slotIndex}:${edge}`, y);
        y += thickness(edge, ky);
      }
      y = slot.y;
      for (const edge of [...slot.incoming].sort((a, b) => {
        const ca = chains[a]!,
          cb = chains[b]!;
        return slots[ca[ca.indexOf(slotIndex) - 1]!]!.y - slots[cb[cb.indexOf(slotIndex) - 1]!]!.y;
      })) {
        ends.set(`${slotIndex}:${edge}`, y);
        y += thickness(edge, ky);
      }
    }
  const links = spec.links.map((link, index) => {
    const chain = chains[index]!,
      h = thickness(index, ky);
    const route = chain.map((slotIndex, i) => ({
      x: stageX(slots[slotIndex]!.stage) + (i === 0 ? nodeWidth : 0),
      y: i === chain.length - 1 ? ends.get(`${slotIndex}:${index}`)! : starts.get(`${slotIndex}:${index}`)!,
    }));
    let d = `M${route[0]!.x},${route[0]!.y}`;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]!,
        b = route[i]!,
        mid = (a.x + b.x) / 2;
      d += `C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;
    }
    d += `L${route.at(-1)!.x},${route.at(-1)!.y + h}`;
    for (let i = route.length - 2; i >= 0; i--) {
      const a = route[i + 1]!,
        b = route[i]!,
        mid = (a.x + b.x) / 2;
      d += `C${mid},${a.y + h} ${mid},${b.y + h} ${b.x},${b.y + h}`;
    }
    return {
      ...link,
      index,
      sourceNode: marks[ids.get(link.source)!]!,
      targetNode: marks[ids.get(link.target)!]!,
      y0: route[0]!.y,
      y1: route.at(-1)!.y,
      height: h,
      route,
      path: d + "Z",
    };
  });
  return { width, height, nodes: marks, links, nodeWidth, scale: ky, header, legend, legendTop: height - bottom };
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
  tax: "var(--k2b-warning-text,#92400e)",
};
export const sankeyColor = (tone: SankeyNode["tone"]) => colors[tone ?? "blue"];

export function renderSankeySvg(spec: SankeyOptions): string {
  const scene = sankeyLayout(spec);
  const number = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumSignificantDigits: 15 }).format;
  const percent = new Intl.NumberFormat(spec.locale ?? "en", { style: "percent", maximumFractionDigits: 1 });
  const body: string[] = [
    scene.header.svg
      .replace(/<text class="stdlib-chart-title"/g, '<text fill="var(--k2b-text,#27272a)" font-size="14" class="stdlib-chart-title"')
      .replace(
        /<text class="stdlib-chart-subtitle"/g,
        '<text fill="var(--k2b-text-muted,#45454e)" font-size="11" class="stdlib-chart-subtitle"',
      ),
  ];
  // Links are painted behind nodes but each inspected datum's first shape carries its own real colour.
  for (const link of scene.links) {
    const mid = (link.sourceNode.x + scene.nodeWidth + link.targetNode.x) / 2;
    const { y0, y1, height: h } = link;
    body.push(
      chartDatumSvg(
        `<path class="k2b-chart-sankey-link" fill="${sankeyColor(link.sourceNode.tone === "muted" ? link.targetNode.tone : link.sourceNode.tone)}" fill-opacity="0.3" stroke="none" d="${link.path}"/>`,
        {
          role: "item",
          index: scene.nodes.length + link.index,
          label: `${link.sourceNode.label} → ${link.targetNode.label}`,
          anchor:
            link.route.length > 2
              ? [link.route[Math.floor(link.route.length / 2)]!.x, link.route[Math.floor(link.route.length / 2)]!.y + h / 2]
              : [mid, (y0 + y1 + h) / 2],
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
    const room = Math.min(150, scene.width - node.x - scene.nodeWidth - 10);
    const value = number(node.value);
    const limit = Math.max(1, Math.min(16, Math.floor(room / 7) - value.length - 1));
    const label = node.label.length > limit ? node.label.slice(0, Math.max(0, limit - 1)) + "…" : node.label;
    // SVG text metrics vary by host font. Bound the complete label, including the value, inside the drawing.
    const length = Math.min(room, (label.length + value.length + 1) * 7);
    body.push(
      chartDatumSvg(
        `<rect x="${node.x}" y="${node.y}" width="${scene.nodeWidth}" height="${node.height}" rx="2" fill="${sankeyColor(node.tone)}" stroke="none"/>${node.showLabel ? `<text x="${node.x + scene.nodeWidth + 6}" y="${node.y + node.height / 2 + 4}" fill="var(--k2b-text,#27272a)" font-size="12" font-family="inherit" textLength="${length}" lengthAdjust="spacingAndGlyphs" stroke="var(--k2b-surface,#fff)" stroke-width="3" paint-order="stroke">${escapeXml(label)} <tspan font-weight="600">${escapeXml(value)}</tspan></text>` : ""}`,
        {
          role: "item",
          index: node.index,
          label: node.label,
          anchor: [node.x + scene.nodeWidth, node.y + node.height / 2],
          values: [
            ...(node.incoming ? [{ key: "incoming", value: node.incoming, formatted: number(node.incoming) }] : []),
            ...(node.outgoing ? [{ key: "outgoing", value: node.outgoing, formatted: number(node.outgoing) }] : []),
          ],
        },
        spec.inspect,
      ),
    );
  }
  for (const item of scene.legend) {
    const y = scene.legendTop + item.row * 20 + 8;
    body.push(
      `<rect x="${item.x}" y="${y}" width="8" height="8" rx="2" fill="${sankeyColor(item.tone)}"/><text x="${item.x + 13}" y="${y + 8}" fill="var(--k2b-text,#27272a)" font-size="11">${escapeXml(item.label.slice(0, Math.floor((scene.width - 30) / 12)))}</text>`,
    );
  }
  return svgRoot({ ...scene, className: spec.className }, body.join(""));
}
