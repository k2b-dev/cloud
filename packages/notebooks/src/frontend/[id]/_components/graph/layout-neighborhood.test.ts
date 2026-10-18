import { expect, test } from "bun:test";
import type { NoteGraph } from "../../../../service/links";
import { bigGraph, FIXTURE_NOW, HANDBOOK_IDS, handbookGraph } from "./graph.fixtures";
import {
  fitNeighborhood,
  layoutNeighborhood,
  NEIGHBORHOOD_STATUS_BAND,
  type NeighborhoodLayout,
  neighborhoodRadius,
} from "./layout-neighborhood";
import { buildGraphModel } from "./model";

const graph = handbookGraph();
const model = buildGraphModel(graph, "en");
const input = { model, visibleIds: new Set(model.byId.keys()), centreId: HANDBOOK_IDS.wein!, depth: 2 as const, portrait: false };
function assertGaps(layout: NeighborhoodLayout) {
  const angles = layout.ring2
    .map((id) => {
      const point = layout.pos.get(id)!;
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(1.75, 12);
      return ((point.th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    })
    .sort((a, b) => a - b);
  const minGap = Math.min(0.22, (2 * Math.PI) / Math.max(1, angles.length));
  if (angles.length > 1)
    for (let i = 0; i < angles.length; i++) {
      const gap = angles[(i + 1) % angles.length]! + (i === angles.length - 1 ? 2 * Math.PI : 0) - angles[i]!;
      expect(gap).toBeGreaterThanOrEqual(minGap - 1e-9);
    }
}
test("directional rings: outgoing right / below, incoming left / above", () => {
  for (const portrait of [false, true]) {
    const result = layoutNeighborhood({ ...input, portrait });
    expect(result.pos.get(input.centreId)).toEqual({ x: 0, y: 0, ring: 0, th: 0 });
    expect(result.outs).toHaveLength(7);
    expect(result.ins).toHaveLength(2);
    for (const id of result.outs) expect(portrait ? result.pos.get(id)!.y : result.pos.get(id)!.x).toBeGreaterThan(0);
    for (const id of result.ins) expect(portrait ? result.pos.get(id)!.y : result.pos.get(id)!.x).toBeLessThan(0);
    assertGaps(result);
  }
});
test("mutual links count once in ring one, as outgoing", () => {
  const result = layoutNeighborhood({ ...input, centreId: HANDBOOK_IDS.sperr! });
  expect(result.outs).toContain(HANDBOOK_IDS.diff!);
  expect(result.ins).not.toContain(HANDBOOK_IDS.diff!);
  expect([...result.pos.keys()].filter((id) => id === HANDBOOK_IDS.diff)).toHaveLength(1);
});
test("one step excludes ring two, isolated centres have no neighbours", () => {
  const one = layoutNeighborhood({ ...input, depth: 1 });
  expect(one.ring2).toEqual([]);
  expect([...one.pos.values()].every((point) => point.ring < 2)).toBe(true);
  const empty = layoutNeighborhood({ ...input, centreId: HANDBOOK_IDS.rampe! });
  expect(empty.outs).toEqual([]);
  expect(empty.ins).toEqual([]);
  expect(empty.pos.size).toBe(1);
});
test("filters exclude hidden nodes and preserve the centre even if hidden", () => {
  const visibleIds = new Set([HANDBOOK_IDS.kuehl!, HANDBOOK_IDS.pack!, HANDBOOK_IDS.vers!]);
  const result = layoutNeighborhood({ ...input, visibleIds });
  expect(result.outs).toEqual([HANDBOOK_IDS.kuehl!]);
  expect(result.ins).toEqual([]);
  expect(result.ring2.toSorted()).toEqual([HANDBOOK_IDS.pack!, HANDBOOK_IDS.vers!].toSorted());
  expect([...result.pos.keys()].every((id) => id === input.centreId || visibleIds.has(id))).toBe(true);
});
test("results are pure and deterministic including shuffled nodes, edges and visible ids", () => {
  const snapshot = structuredClone(model);
  const expected = layoutNeighborhood(input);
  expect(layoutNeighborhood(input)).toEqual(expected);
  expect(
    layoutNeighborhood({
      ...input,
      model: buildGraphModel({ nodes: graph.nodes.toReversed(), edges: graph.edges.toReversed() }, "en"),
      visibleIds: new Set([...input.visibleIds].reverse()),
    }),
  ).toEqual(expected);
  expect(model).toEqual(snapshot);
});
test("every big-graph centre obeys the circular minimum including the wrap", () => {
  const model = buildGraphModel(bigGraph(), "en");
  for (const note of model.notes)
    assertGaps(layoutNeighborhood({ ...input, model, visibleIds: new Set(model.byId.keys()), centreId: note.id }));
});
test("crowded shared neighbours obey minGap, including more than a full ring at 0.22", () => {
  for (const count of [2, 12, 28, 29, 100, 300]) {
    const graph: NoteGraph = {
      nodes: Array.from({ length: count + 3 }, (_, i) => ({
        id: String(i),
        title: String(i),
        parentId: null,
        position: i,
        updatedAt: FIXTURE_NOW,
        inDegree: 0,
      })),
      edges: [
        { source: "0", target: "1" },
        { source: "2", target: "0" },
        ...Array.from({ length: count }, (_, i) => [
          { source: "1", target: String(i + 3) },
          { source: String(i + 3), target: "2" },
        ]).flat(),
      ],
    };
    const model = buildGraphModel(graph, "en");
    const local = layoutNeighborhood({ ...input, model, centreId: "0", visibleIds: new Set(model.byId.keys()) });
    expect(local.ring2).toHaveLength(count);
    assertGaps(local);
    expect(
      layoutNeighborhood({
        ...input,
        model: buildGraphModel({ nodes: graph.nodes.toReversed(), edges: graph.edges.toReversed() }, "en"),
        centreId: "0",
        visibleIds: new Set(model.byId.keys()),
      }),
    ).toEqual(local);
  }
});
test("fit uses a bounded portrait ellipse and constant screen radii", () => {
  const view = fitNeighborhood({ width: 390, height: 700, ext: 1.75, portrait: true });
  expect(view.ay).toBeGreaterThan(1);
  expect(view.ay).toBeLessThanOrEqual(2.6);
  expect(view.tx).toBe(195);
  expect(fitNeighborhood({ width: 390, height: 2000, ext: 1, portrait: true }).ay).toBe(2.6);
  // The outer ring leaves room for a heading above it and for a heading and the status line below it.
  for (const [width, height, portrait] of [
    [390, 700, true],
    [820, 1100, true],
    [1440, 800, false],
    [1194, 760, false],
  ] as const) {
    const fit = fitNeighborhood({ width, height, ext: 1.75, portrait });
    const extent = fit.k * fit.ay * 1.75;
    // A heading's baseline sits 12 (portrait) or 14 px above the ring; its box reaches 13 px higher.
    const headingRoom = (portrait ? 12 : 14) + 13;
    expect(fit.ty - extent - headingRoom).toBeGreaterThanOrEqual(2);
    expect(fit.ty + extent + (portrait ? 22 + 5 : 0)).toBeLessThanOrEqual(height - NEIGHBORHOOD_STATUS_BAND);
  }
  const landscape = fitNeighborhood({ width: 1440, height: 800, ext: 1.75, portrait: false });
  expect(landscape).toEqual({ k: Math.min((720 - 190 - 12) / 1.75, (800 - 70) / 2 / 1.75), ay: 1, tx: 720, ty: 30 + (800 - 70) / 2 });
  expect(neighborhoodRadius(0, 0)).toBe(11);
  expect(neighborhoodRadius(1, 0)).toBe(4.5);
  expect(neighborhoodRadius(1, 100)).toBe(8);
  expect(neighborhoodRadius(2, 100)).toBe(3.6);
});

test("first-ring order and angles follow area then tree order in both orientations", () => {
  const outs = [...model.byId.get(input.centreId)!.out].sort(
    (a, b) => model.byId.get(a)!.area.index - model.byId.get(b)!.area.index || model.byId.get(a)!.order - model.byId.get(b)!.order,
  );
  const ins = [...model.byId.get(input.centreId)!.in].sort(
    (a, b) => model.byId.get(a)!.area.index - model.byId.get(b)!.area.index || model.byId.get(a)!.order - model.byId.get(b)!.order,
  );
  for (const portrait of [false, true]) {
    const local = layoutNeighborhood({ ...input, portrait });
    expect(local.outs).toEqual(portrait ? outs.toReversed() : outs);
    expect(local.ins).toEqual(portrait ? ins : ins.toReversed());
    for (const [ids, mid, maxSpan] of [
      [local.outs, portrait ? Math.PI / 2 : 0, Math.PI * (portrait ? 0.8 : 0.86)],
      [local.ins, portrait ? -Math.PI / 2 : Math.PI, Math.PI * (portrait ? 0.8 : 0.86)],
    ] as const) {
      const span = Math.min(maxSpan, (ids.length - 1) * 0.36);
      ids.forEach((id, i) => expect(local.pos.get(id)!.th).toBeCloseTo(mid - span / 2 + (i / (ids.length - 1)) * span, 12));
    }
  }
});
