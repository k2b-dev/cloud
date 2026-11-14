import { expect, test } from "bun:test";
import { chartRenderHeight } from "./render-size";
import { renderSankeySvg, sankeyFrame, sankeyGraph, sankeyLayout } from "./sankey";

const spec = {
  nodes: [
    { id: "a", label: "Click" },
    { id: "b", label: "Read" },
    { id: "c", label: "Signup" },
  ],
  links: [
    { source: "a", target: "b", value: 100 },
    { source: "a", target: "c", value: 20 },
    { source: "b", target: "c", value: 50 },
  ],
};
test("longest path places converging nodes after every source and retains imbalance", () => {
  const { nodes, links, width } = sankeyLayout(spec);
  expect(nodes.map((n) => n.stage)).toEqual([0, 1, 2]);
  expect(nodes.map((n) => [n.incoming, n.outgoing, n.value])).toEqual([
    [0, 120, 120],
    [100, 50, 100],
    [70, 0, 70],
  ]);
  expect(links[2]!.height / nodes[1]!.height).toBeCloseTo(0.5);
  expect(width).toBe(620);
  expect(sankeyLayout({ ...spec, displayWidth: 900 }).width).toBe(900);
});
test("invalid graphs fail before layout, including prototype-like ids", () => {
  for (const links of [
    [{ source: "a", target: "missing", value: 1 }],
    [{ source: "a", target: "a", value: 1 }],
    [{ source: "a", target: "b", value: 0 }],
    [{ source: "a", target: "b", value: -1 }],
  ])
    expect(() => sankeyGraph({ ...spec, links })).toThrow();
  expect(() => sankeyGraph({ ...spec, nodes: [spec.nodes[0]!, spec.nodes[0]!] })).toThrow();
  expect(
    sankeyGraph({
      nodes: [
        { id: "__proto__", label: "A" },
        { id: "b", label: "B" },
      ],
      links: [{ source: "__proto__", target: "b", value: 1 }],
    }).nodes[1]!.stage,
  ).toBe(1);
});
test("source colors have literal standalone fallbacks; escaped labels and raw inspection values", () => {
  const svg = renderSankeySvg({
    ...spec,
    nodes: spec.nodes.map((n) => ({ ...n, label: "<" + n.label, tone: "in" as const })),
    inspect: true,
    locale: "de",
  });
  expect(svg).toContain('fill="var(--k2b-flow-in-mark,#0891b2)"');
  expect(svg).toContain("&lt;Click");
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(svg).toContain("&quot;incoming&quot;");
  expect(svg).toContain("&quot;outgoing&quot;");
  expect(renderSankeySvg({ nodes: [], links: [] })).not.toMatch(/NaN|Infinity/);
});

test("dense nodes, tiny flows and skipped stages keep visible, disjoint slots", () => {
  const dense = {
    nodes: [{ id: "root", label: "Root" }, ...Array.from({ length: 30 }, (_, i) => ({ id: String(i), label: "Long label " + i }))],
    links: Array.from({ length: 30 }, (_, i) => ({ source: "root", target: String(i), value: i === 0 ? 100000 : 1 })),
  };
  const scene = sankeyLayout(dense);
  expect(scene.scale).toBeGreaterThan(0);
  for (const node of scene.nodes) expect(node.height).toBeGreaterThanOrEqual(2);
  for (const link of scene.links) expect(link.height).toBeGreaterThanOrEqual(1);
  const column = scene.nodes.filter((n) => n.stage === 1).sort((a, b) => a.y - b.y);
  for (let i = 1; i < column.length; i++) expect(column[i]!.y).toBeGreaterThanOrEqual(column[i - 1]!.y + column[i - 1]!.height);
  expect(column.filter((n) => n.showLabel).length).toBeLessThan(30);
  const s = sankeyLayout(spec),
    route = s.links[1]!.route[1]!,
    node = s.nodes[1]!;
  expect(route.y >= node.y + node.height || route.y + s.links[1]!.height <= node.y).toBe(true);
});
test("headers, explicit wrapping legends and muted-source flow colors", () => {
  const legend = Array.from({ length: 8 }, (_, i) => ({ tone: "tax" as const, label: "Explicit meaning " + i }));
  const s = sankeyLayout({ ...spec, title: "Paths", subtitle: "November", legend });
  expect(s.legend.at(-1)!.row).toBeGreaterThan(0);
  expect(s.nodes[0]!.y).toBeGreaterThanOrEqual(s.header.height);
  const svg = renderSankeySvg({
    ...spec,
    title: "Paths",
    subtitle: "November",
    legend,
    nodes: spec.nodes.map((n, i) => ({ ...n, tone: i === 0 ? "muted" : "green" })),
  });
  expect(svg).toContain("stdlib-chart-title");
  expect(svg).toContain("November");
  expect(svg).toContain("Explicit meaning 7");
  expect(svg).toContain('k2b-chart-sankey-link" fill="var(--stdlib-chart-c2,#10b981)');
  expect(svg).not.toContain("data-chart-scroll");
});

test("labels truncate by glyph width without deforming their natural metrics", () => {
  const svg = renderSankeySvg({ ...spec, nodes: spec.nodes.map((n) => ({ ...n, label: "WWW iii WWW iii WWW iii WWW iii WWW iii" })) });
  expect(svg).not.toMatch(/textLength|lengthAdjust/);
  expect(svg).toContain("…");
});

test("eager sizing matches renderer geometry for dense and stage-skipping flows", () => {
  for (const count of [1, 30, 100]) {
    const dense = {
      nodes: [...Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `Source ${i}` })), { id: "target", label: "Target" }],
      links: Array.from({ length: count }, (_, i) => ({ source: `s${i}`, target: "target", value: 1 })),
      title: "Flows",
      subtitle: "Fictional",
      legend: [{ tone: "in" as const, label: "Incoming" }],
    };
    for (const width of [390, 900]) {
      const size = { width, height: 280 };
      expect(sankeyFrame(dense, size).height).toBe(sankeyLayout(dense, size).height);
      expect(chartRenderHeight({ ...dense, kind: "sankey" })).toBe(sankeyLayout(dense).height);
      expect(sankeyFrame(dense, size).width).toBe(sankeyLayout(dense, size).width);
    }
  }
  expect(sankeyFrame(spec).height).toBe(sankeyLayout(spec).height);
});

test("long node names wrap at words while full text remains in inspection metadata", () => {
  const label = "Weekly letter newsletter subscribers";
  const svg = renderSankeySvg({ ...spec, inspect: true, nodes: spec.nodes.map((n) => ({ ...n, label })) });
  expect(svg).toContain(">Weekly letter</text>");
  expect(svg).toContain(label);
  expect(svg).toContain("…");
  expect(svg).not.toMatch(/textLength|lengthAdjust/);
});
