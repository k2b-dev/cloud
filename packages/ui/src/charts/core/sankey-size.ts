import type { SankeyNode, SankeyOptions } from "./sankey";
import { renderHeader } from "./svg";

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

/** Reserve the exact drawing box without importing the renderer. */
export function sankeyFrame(spec: SankeyOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
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
  const { nodes, ids } = sankeyGraph(spec);
  const incoming = nodes.map(() => 0);
  const minimum = Array.from({ length: Math.max(0, ...nodes.map((node) => node.stage)) + 1 }, () => 0);
  for (const link of spec.links) {
    const source = nodes[ids.get(link.source)!]!;
    const target = nodes[ids.get(link.target)!]!;
    incoming[target.index]!++;
    for (let stage = source.stage + 1; stage < target.stage; stage++) minimum[stage]! += 2;
  }
  for (const node of nodes) minimum[node.stage]! += Math.max(2, incoming[node.index]!, node.edges.length);
  const height = Math.max(size.height, top + bottom + Math.max(0, ...minimum) * 1.5);
  return { width, height, header, legend, top, bottom };
}
