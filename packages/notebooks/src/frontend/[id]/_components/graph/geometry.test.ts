import { expect, test } from "bun:test";
import { convexHull, fitView, rectsIntersect, screenRadius, spatialNext, toScreen, toWorld, zoomView } from "./geometry";
import { handbookGraph } from "./graph.fixtures";
import { layoutNetwork, nodeRadius } from "./layout-net";
import { buildGraphModel } from "./model";

test("fit projects handbook positions inside both canvas sizes", () => {
  const positions = layoutNetwork(buildGraphModel(handbookGraph()));
  for (const [width, height, compact] of [
    [1440, 800, false],
    [390, 640, true],
  ] as const) {
    const view = fitView(positions.values(), width, height, compact);
    for (const point of positions.values()) {
      const screen = toScreen(view, point);
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(width);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeLessThanOrEqual(height);
      expect(toWorld(view, screen).x).toBeCloseTo(point.x, 10);
      expect(toWorld(view, screen).y).toBeCloseTo(point.y, 10);
    }
  }
  expect(fitView([], 390, 640, true)).toEqual({ k: 1, tx: 195, ty: 320 });
  expect(fitView([{ x: 0, y: 0 }], 1440, 800, false).k).toBe(2.2);
  expect(
    fitView(
      [
        { x: -10000, y: 0 },
        { x: 10000, y: 0 },
      ],
      390,
      640,
      true,
    ).k,
  ).toBe(0.2);
});
test("zoom clamps and preserves the world coordinate under the anchor", () => {
  const view = { k: 1.2, tx: 30, ty: -20 };
  const original = { ...view };
  const anchor = { x: 175, y: 260 };
  const world = toWorld(view, anchor);
  for (const [factor, k] of [
    [1000, 4.8],
    [0.0001, 0.32],
    [2, 2.4],
  ]) {
    if (factor === undefined || k === undefined) throw new Error("Missing zoom case");
    const next = zoomView(view, factor, anchor.x, anchor.y, 0.8);
    expect(next.k).toBeCloseTo(k, 12);
    expect(toScreen(next, world).x).toBeCloseTo(anchor.x, 10);
    expect(toScreen(next, world).y).toBeCloseTo(anchor.y, 10);
    expect(next).not.toBe(view);
  }
  expect(view).toEqual(original);
  expect(screenRadius(4, 0.01)).toBe(nodeRadius(4) * 0.75);
  expect(screenRadius(4, 100)).toBe(nodeRadius(4) * 1.5);
});
test("monotone hull excludes interior and collinear points without mutating input", () => {
  const points = [
    { x: 2, y: 2 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { x: 1, y: 0 },
  ];
  const before = structuredClone(points);
  expect(convexHull(points)).toEqual([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ]);
  expect(points).toEqual(before);
  expect(convexHull([])).toEqual([]);
  expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  expect(
    convexHull([
      { x: 2, y: 2 },
      { x: 0, y: 0 },
    ]),
  ).toEqual([
    { x: 0, y: 0 },
    { x: 2, y: 2 },
  ]);
  expect(
    convexHull([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]),
  ).toEqual([
    { x: 0, y: 0 },
    { x: 2, y: 2 },
  ]);
});
test("spatial navigation scores direction and perpendicular distance with stable ties", () => {
  const from = { x: 100, y: 100 };
  const candidates = [
    { id: "self", point: from },
    { id: "near-axis", point: { x: 102, y: 100 } },
    { id: "diagonal", point: { x: 110, y: 120 } },
    { id: "right", point: { x: 130, y: 100 } },
    { id: "tie", point: { x: 130, y: 100 } },
    { id: "up", point: { x: 100, y: 80 } },
  ];
  expect(spatialNext(from, "right", candidates)).toBe("right");
  expect(spatialNext(from, "left", candidates)).toBeNull();
  expect(spatialNext(from, "up", candidates)).toBe("up");
  expect(spatialNext(from, "down", candidates)).toBe("diagonal");
  expect(spatialNext(from, "right", [])).toBeNull();
});
test("rectangles may touch but cannot overlap", () => {
  const a = { x0: 2, y0: 2, x1: 12, y1: 12 };
  expect(rectsIntersect(a, { x0: 12, y0: 2, x1: 22, y1: 12 })).toBe(false);
  expect(rectsIntersect(a, { x0: 11, y0: 2, x1: 22, y1: 12 })).toBe(true);
});
