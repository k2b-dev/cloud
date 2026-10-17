import { expect, test } from "bun:test";
import { fitView, type Rect, rectsIntersect, screenRadius, toScreen } from "./geometry";
import { bigGraph, handbookGraph } from "./graph.fixtures";
import { fitText, LABEL_FONTS, type LabelNode, type Measure, placeLabels } from "./labels";
import { layoutNetwork } from "./layout-net";
import { buildGraphModel } from "./model";

const measure: Measure = (text, font) => ((text.length * 6.5 * font.size) / 12) * (font.weight >= 600 ? 1.08 : 1);
function assertRects(rects: readonly Rect[], width: number, height: number) {
  for (const [index, rect] of rects.entries()) {
    expect(rect.x0).toBeGreaterThanOrEqual(2);
    expect(rect.y0).toBeGreaterThanOrEqual(2);
    expect(rect.x1).toBeLessThanOrEqual(width - 2);
    expect(rect.y1).toBeLessThanOrEqual(height - 2);
    for (const other of rects.slice(index + 1)) expect(rectsIntersect(rect, other)).toBe(false);
  }
}
const node = (overrides: Partial<LabelNode> = {}): LabelNode => ({
  id: "note01",
  title: "Current note",
  x: 200,
  y: 200,
  r: 8,
  deg: 1,
  kind: "normal",
  ...overrides,
});
const place = (nodes: readonly LabelNode[], areaLabels: Parameters<typeof placeLabels>[0]["areaLabels"] = [], maxLabels = 400) =>
  placeLabels({ width: 390, height: 640, nodes, areaLabels, measure, maxLabels, maxWidth: 130 });

for (const [name, fixture] of [
  ["handbook", handbookGraph],
  ["big", bigGraph],
] as const) {
  test(`${name}: projected labels obey bounds, shared collision rules, node obstacles and budget`, () => {
    const model = buildGraphModel(fixture());
    const positions = layoutNetwork(model);
    for (const [width, height, compact] of [
      [1440, 800, false],
      [390, 640, true],
    ] as const) {
      const view = fitView(positions.values(), width, height, compact);
      const nodes = model.notes.map((note, index): LabelNode => {
        const point = positions.get(note.id);
        if (!point) throw new Error("Missing layout node");
        return {
          id: note.id,
          title: note.title,
          ...toScreen(view, point),
          r: screenRadius(note.deg, view.k),
          deg: note.deg,
          kind: index === 0 ? "current" : index === 1 ? "hover" : index % 3 === 0 ? "neighbour" : index % 7 === 0 ? "hit" : "normal",
        };
      });
      const areaLabels = model.areas.slice(1).map((area) => {
        const members = nodes.filter((node) => model.byId.get(node.id)?.area === area);
        return {
          key: area.key,
          text: area.title ?? "",
          x: members.reduce((sum, node) => sum + node.x, 0) / members.length,
          y: Math.min(...members.map((node) => node.y)) - 28,
        };
      });
      const maxLabels = compact ? 60 : 400;
      const input = { width, height, nodes, areaLabels, measure, maxLabels, maxWidth: compact ? 130 : 190 };
      const result = placeLabels(input);
      expect(result).toEqual(placeLabels(input));
      expect(result.labels.length).toBeGreaterThan(2);
      expect(result.labels.filter((label) => label.kind !== "current" && label.kind !== "hover").length).toBeLessThanOrEqual(maxLabels);
      expect(result.labels.some((label) => label.kind === "current")).toBe(true);
      expect(result.labels.some((label) => label.kind === "hover")).toBe(true);
      assertRects([...result.labels.map((label) => label.rect), ...result.areaLabels.map((label) => label.rect)], width, height);
      for (const label of result.labels.filter((label) => label.kind !== "current" && label.kind !== "hover")) {
        for (const node of nodes) {
          const r = node.r + 1;
          expect(rectsIntersect(label.rect, { x0: node.x - r, y0: node.y - r, x1: node.x + r, y1: node.y + r })).toBe(false);
        }
      }
    }
  });
}
test("forced current labels stay inside all canvas edges and corners", () => {
  for (const x of [0, 1, 195, 389, 390])
    for (const y of [0, 1, 320, 639, 640]) {
      const result = place([node({ x, y, kind: "current" })]);
      expect(result.labels).toHaveLength(1);
      const label = result.labels[0];
      expect(label?.chip).toEqual(label?.rect);
      assertRects(
        result.labels.map((label) => label.rect),
        390,
        640,
      );
    }
});
test("hover drops a colliding area label when every candidate is blocked", () => {
  const target = node({ id: "hover1", title: "Hover", kind: "hover", x: 100, y: 100 });
  const result = place(
    [
      target,
      node({ id: "block1", x: 150, y: 100, r: 55, title: "" }),
      node({ id: "block2", x: 50, y: 100, r: 55, title: "" }),
      node({ id: "block3", x: 100, y: 135, r: 30, title: "" }),
      node({ id: "block4", x: 100, y: 65, r: 30, title: "" }),
    ],
    [{ key: "area01", text: "Area", x: 130, y: 105 }],
  );
  expect(result.labels.map((label) => label.id)).toEqual(["hover1"]);
  expect(result.areaLabels).toEqual([]);
  assertRects(
    result.labels.map((label) => label.rect),
    390,
    640,
  );
});
test("forced labels never overlap each other, even at the same canvas corner", () => {
  const result = place([
    node({ id: "hover1", x: 0, y: 0, kind: "hover", deg: 10000 }),
    node({ id: "cur001", x: 0, y: 0, kind: "current" }),
  ]);
  expect(result.labels.map((label) => label.id)).toEqual(["cur001", "hover1"]);
  assertRects(
    result.labels.map((label) => label.rect),
    390,
    640,
  );
});
test("area labels are placed in input order, with bounds and overlaps dropping later labels", () => {
  const result = place(
    [],
    [
      { key: "first1", text: "First", x: 100, y: 100 },
      { key: "later1", text: "Later", x: 100, y: 100 },
      { key: "edge01", text: "Outside", x: 0, y: 5 },
      { key: "last01", text: "Last", x: 250, y: 200 },
    ],
  );
  expect(result.areaLabels.map((label) => label.key)).toEqual(["first1", "last01"]);
  assertRects(
    result.areaLabels.map((label) => label.rect),
    390,
    640,
  );
});
test("budget exempts current and hover; priority and ties keep stable input order", () => {
  const nodes = [
    node({ id: "first1", x: 50, y: 50 }),
    node({ id: "second", x: 200, y: 50 }),
    node({ id: "hover1", x: 50, y: 150, kind: "hover" }),
    node({ id: "cur001", x: 50, y: 250, kind: "current" }),
  ];
  expect(place(nodes, [], 0).labels.map((label) => label.id)).toEqual(["cur001", "hover1"]);
  expect(place(nodes, [], 1).labels.map((label) => label.id)).toEqual(["cur001", "hover1", "first1"]);
  expect(
    place(
      [node({ id: "normal", deg: 400 }), node({ id: "neighb", y: 300, kind: "neighbour" }), node({ id: "hit001", y: 400, kind: "hit" })],
      [],
      2,
    ).labels.map((label) => label.id),
  ).toEqual(["hit001", "neighb"]);
});
test("fully off-canvas circles get no labels", () => {
  expect(place([node({ x: -10, kind: "current" }), node({ x: 400, kind: "hover" }), node({ y: -10 }), node({ y: 650 })]).labels).toEqual(
    [],
  );
});
test("fitText binary search uses the ellipsis and requires three prefix characters", () => {
  const font = LABEL_FONTS.normal;
  expect(fitText("Hi", 100, font, measure)).toBe("Hi");
  expect(fitText("Handbook", measure("Hand…", font), font, measure)).toBe("Hand…");
  expect(fitText("Handbook", measure("Ha…", font), font, measure)).toBe("");
  expect(fitText("Handbook", 0, font, measure)).toBe("");
  expect(fitText("Hand book", measure("Hand …", font), font, measure)).toBe("Hand…");
});
