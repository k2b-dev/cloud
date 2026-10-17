import { expect, test } from "bun:test";
import { bigGraph, handbookGraph } from "./graph.fixtures";
import { CIRCLE_STATUS_BAND, chordPath, circleRadius, fitCircle, layoutCircle, ringStep } from "./layout-circle";
import { buildGraphModel, type GraphModel, type GraphNote, visibleNotes } from "./model";

const TAU = 2 * Math.PI;
function assertLayout(notes: readonly GraphNote[]) {
  const layout = layoutCircle(notes);
  const sorted = notes.toSorted((a, b) => a.area.index - b.area.index || a.order - b.order);
  expect(layout.order).toEqual(sorted.map((note) => note.id));
  const areaCount = new Set(notes.map((note) => note.area.key)).size;
  expect(layout.arcs).toHaveLength(areaCount);
  const gap = Math.max(1.2, notes.length / 60),
    slotAngle = TAU / (notes.length + areaCount * gap);
  let gaps = 0;
  for (const [i, note] of sorted.entries()) {
    const point = layout.pos.get(note.id)!;
    expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 12);
    expect(point.th).toBeGreaterThanOrEqual(-Math.PI / 2);
    expect(point.th).toBeLessThan((3 * Math.PI) / 2);
    if (i) expect(point.th).toBeGreaterThan(layout.pos.get(sorted[i - 1]!.id)!.th);
    const next = sorted[(i + 1) % sorted.length]!;
    const isGap = next.area.key !== note.area.key || i === sorted.length - 1;
    if (isGap) gaps++;
    const delta = layout.pos.get(next.id)!.th + (i === sorted.length - 1 ? TAU : 0) - point.th;
    expect(delta).toBeCloseTo(slotAngle * (isGap ? 1 + gap : 1), 12);
    const arc = layout.arcs.find((arc) => arc.area.key === note.area.key)!;
    expect(point.th).toBeGreaterThan(arc.t0);
    expect(point.th).toBeLessThan(arc.t1);
  }
  expect(gaps).toBe(areaCount);
  for (const [i, arc] of layout.arcs.entries()) {
    expect(arc.t1 - arc.t0).toBeCloseTo(sorted.filter((note) => note.area.key === arc.area.key).length * slotAngle, 12);
    if (i) expect(arc.t0).toBeGreaterThan(layout.arcs[i - 1]!.t1);
  }
  return layout;
}
function assertSteps(model: GraphModel, notes: readonly GraphNote[]) {
  const layout = layoutCircle(notes),
    areaOf = (id: string) => model.byId.get(id)!.area.key;
  const { order } = layout;
  let id = order[0]!;
  for (const next of [...order.slice(1), order[0]!]) {
    expect(ringStep(layout, areaOf, id, "ArrowDown")).toBe(next);
    expect(ringStep(layout, areaOf, id, "ArrowRight")).toBe(next);
    expect(ringStep(layout, areaOf, next, "ArrowLeft")).toBe(id);
    expect(ringStep(layout, areaOf, next, "ArrowUp")).toBe(id);
    id = next;
  }
  const first = order.filter((id, i) => i === 0 || areaOf(id) !== areaOf(order[i - 1]!));
  for (const id of order) {
    const index = first.findIndex((start) => areaOf(start) === areaOf(id));
    expect(ringStep(layout, areaOf, id, "PageDown")).toBe(first[(index + 1) % first.length]!);
    expect(ringStep(layout, areaOf, id, "PageUp")).toBe(first[(index - 1 + first.length) % first.length]!);
  }
  expect(ringStep(layout, areaOf, "unknown", "ArrowRight")).toBeNull();
}
for (const [name, fixture] of [
  ["handbook", handbookGraph],
  ["big", bigGraph],
] as const) {
  const model = buildGraphModel(fixture(), "en");
  test(`${name}: ring slots, area arcs and wrap gap follow area and tree order`, () => {
    const notes = visibleNotes(model, { links: "all", hide: [] });
    const snapshot = structuredClone(notes);
    const layout = assertLayout(notes);
    expect(layoutCircle(notes)).toEqual(layout);
    const shuffled = [...notes.filter((_, i) => i % 2), ...notes.filter((_, i) => i % 2 === 0)].reverse();
    expect(layoutCircle(shuffled)).toEqual(layout);
    expect(notes).toEqual(snapshot);
  });
  test(`${name}: hidden areas remove their slots and gap`, () => {
    const hidden = model.areas.find((area) => area.count > 0)!;
    const notes = visibleNotes(model, { links: "all", hide: [hidden.key] });
    expect(notes.length).toBe(model.notes.length - hidden.count);
    const layout = assertLayout(notes);
    expect(layout.arcs.some((arc) => arc.area.key === hidden.key)).toBe(false);
    for (const note of model.notes.filter((note) => note.area.key === hidden.key)) expect(layout.pos.has(note.id)).toBe(false);
  });
  test(`${name}: ring keyboard wraps and area jumps always land on first notes`, () => {
    assertSteps(model, model.notes);
    assertSteps(model, visibleNotes(model, { links: "all", hide: [model.notes[0]!.area.key] }));
    assertSteps(
      model,
      model.notes.filter((note) => note.area.key === model.notes[0]!.area.key),
    );
  });
}
test("empty and single-note circles", () => {
  expect(layoutCircle([])).toEqual({ pos: new Map(), arcs: [], order: [] });
  expect(ringStep(layoutCircle([]), () => "top", "unknown", "PageUp")).toBeNull();
  const model = buildGraphModel(handbookGraph(), "en");
  assertLayout([model.notes[0]!]);
  assertSteps(model, [model.notes[0]!]);
});
test("fit reserves radial title space and the status band; radii stay in screen pixels", () => {
  for (const [width, height, compact] of [
    [1440, 800, false],
    [390, 640, true],
  ] as const) {
    const m = Math.min(width, height - CIRCLE_STATUS_BAND);
    expect(fitCircle(width, height, compact)).toEqual({
      k: Math.max(40, m / 2 - Math.min(170, Math.max(64, m * 0.21)) - (compact ? 6 : 16)),
      tx: width / 2,
      ty: (height - CIRCLE_STATUS_BAND) / 2,
    });
  }
  expect(fitCircle(20, 20, true).k).toBe(40);
  expect(circleRadius(0)).toBe(2.6);
  expect(circleRadius(4)).toBe(4.4);
  expect(circleRadius(100)).toBe(6.5);
});
test("chords pull endpoints inside the band and control radius follows angular distance", () => {
  const k = 200,
    cx = 400,
    cy = 300;
  const screen = (p: { x: number; y: number }) => ({ x: cx + p.x * k, y: cy + p.y * k });
  const point = (th: number) => ({ x: Math.cos(th), y: Math.sin(th), th });
  const controls: number[] = [];
  for (const d of [0.2, 1, Math.PI, TAU - 0.2]) {
    const a = point(0),
      b = point(d);
    const path = chordPath(a, b, k, screen, 0);
    const values = path.match(/-?\d+\.\d+/g)!.map(Number);
    const [ax, ay, qx, qy, bx, by] = values as [number, number, number, number, number, number];
    expect(Math.hypot(ax - cx, ay - cy)).toBeCloseTo(k - 21, 0);
    expect(Math.hypot(bx - cx, by - cy)).toBeCloseTo(k - 21, 0);
    const mx = ((a.x + b.x) / 2) * (1 - 21 / k),
      my = ((a.y + b.y) / 2) * (1 - 21 / k);
    const pull = (1 - Math.min(d, TAU - d) / Math.PI) * 0.55;
    const radius = Math.hypot(qx - cx, qy - cy);
    expect(radius).toBeCloseTo(Math.min(Math.hypot(mx, my), pull) * k, 0);
    controls.push(radius);
    const shifted = chordPath(a, b, k, screen, 2)
      .match(/-?\d+\.\d+/g)!
      .map(Number);
    for (let i = 0; i < 6; i += 2) {
      const dx = shifted[i]! - values[i]!,
        dy = shifted[i + 1]! - values[i + 1]!;
      expect(Math.hypot(dx, dy)).toBeCloseTo(2, 0);
      expect(dx).toBeCloseTo(shifted[0]! - ax, 0);
      expect(dy).toBeCloseTo(shifted[1]! - ay, 0);
    }
  }
  expect(controls[0]!).toBeGreaterThan(controls[1]!);
  expect(controls[1]!).toBeGreaterThan(controls[2]!);
});
