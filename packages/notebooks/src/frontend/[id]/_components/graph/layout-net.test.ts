import { expect, test } from "bun:test";
import { bigGraph, handbookGraph } from "./graph.fixtures";
import { layoutNetwork, layoutNetworkInSlices, type NetPoint, nodeRadius, seededRandom } from "./layout-net";
import { buildGraphModel } from "./model";

for (const [name, fixture] of [
  ["handbook", handbookGraph],
  ["big", bigGraph],
] as const) {
  test(`${name}: deterministic, finite, collision-free layout independent of transport order`, () => {
    const graph = fixture();
    const snapshot = structuredClone(graph);
    const model = buildGraphModel(graph, "en");
    const before = structuredClone(model);
    const started = performance.now();
    const positions = layoutNetwork(model);
    if (name === "big") console.info(`Network layout: ${model.notes.length} notes in ${(performance.now() - started).toFixed(1)} ms`);
    expect(model.notes).toHaveLength(name === "big" ? 300 : 49);
    expect([...positions]).toEqual([...layoutNetwork(model)]);
    expect([...positions]).toEqual([
      ...layoutNetwork(buildGraphModel({ nodes: graph.nodes.toReversed(), edges: graph.edges.toReversed() }, "en")),
    ]);
    expect(model).toEqual(before);
    expect(graph).toEqual(snapshot);
    expect([...positions.keys()]).toEqual(model.notes.map((note) => note.id));
    for (const [i, note] of model.notes.entries()) {
      const a = positions.get(note.id);
      if (!a) throw new Error("Missing layout node");
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      for (const other of model.notes.slice(i + 1)) {
        const b = positions.get(other.id);
        if (!b) throw new Error("Missing layout node");
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(nodeRadius(note.deg) + nodeRadius(other.deg));
      }
    }
  });
}
test("handbook areas stay clustered around their own centroids", () => {
  const model = buildGraphModel(handbookGraph(), "en");
  const positions = layoutNetwork(model);
  const groups = model.areas.map((area) =>
    model.notes
      .filter((note) => note.area === area)
      .flatMap((note) => {
        const point = positions.get(note.id);
        return point ? [point] : [];
      }),
  );
  const centres = groups.map((points) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  }));
  const meanDistance = (points: NetPoint[], centre: NetPoint) =>
    points.reduce((sum, point) => sum + Math.hypot(point.x - centre.x, point.y - centre.y), 0) / points.length;
  for (const [index, points] of groups.entries()) {
    const own = centres[index];
    if (index === 0 || !own) continue;
    for (const [otherIndex, other] of centres.entries())
      if (index !== otherIndex) expect(meanDistance(points, own)).toBeLessThan(meanDistance(points, other));
  }
});
test("mulberry32 matches the prototype and empty/singleton layouts are finite", () => {
  const random = seededRandom(7);
  expect([random(), random(), random()]).toEqual([0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
  expect(layoutNetwork(buildGraphModel({ nodes: [], edges: [] }, "en"))).toEqual(new Map());
  const graph = handbookGraph();
  graph.nodes = graph.nodes.slice(0, 1);
  graph.edges = [];
  const point = [...layoutNetwork(buildGraphModel(graph, "en")).values()][0];
  expect(point && Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
});

test("the sliced layout yields to the page and still gives exactly the same positions", async () => {
  const model = buildGraphModel(bigGraph(), "en");
  let yielded = 0;
  const counting = setInterval(() => yielded++, 0);
  const sliced = await layoutNetworkInSlices(model, new AbortController().signal);
  clearInterval(counting);
  expect(sliced && [...sliced]).toEqual([...layoutNetwork(model)]);
  expect(yielded).toBeGreaterThan(0);
  const controller = new AbortController();
  const aborted = layoutNetworkInSlices(model, controller.signal);
  controller.abort();
  expect(await aborted).toBeNull();
});
