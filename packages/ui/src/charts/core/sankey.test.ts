import { expect, test } from "bun:test";
import { renderSankeySvg, sankeyGraph, sankeyLayout } from "./sankey";

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
