import { NEIGHBORHOOD_STATUS_BAND } from "./layout-neighborhood";
import type { GraphArea, GraphNote } from "./model";

export const CIRCLE_STATUS_BAND = NEIGHBORHOOD_STATUS_BAND;
export type CirclePoint = { x: number; y: number; th: number };
export type CircleArc = { area: GraphArea; t0: number; t1: number };
export type CircleLayout = { pos: Map<string, CirclePoint>; arcs: CircleArc[]; order: string[] };
export type CircleKey = "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp" | "PageDown" | "PageUp";
const TAU = 2 * Math.PI;
const f1 = (value: number) => value.toFixed(1);

/**
 * Every visible note on one unit ring, starting at the top and running clockwise: areas in area order, notes in tree
 * order, and one gap of `max(1.2, n/60)` slots between areas, also from the last area back to the first. Hidden areas
 * are not in `notes`, so they leave no gap.
 */
export function layoutCircle(notes: readonly GraphNote[]): CircleLayout {
  const sorted = notes.toSorted((a, b) => a.area.index - b.area.index || a.order - b.order);
  const pos = new Map<string, CirclePoint>();
  const arcs: CircleArc[] = [];
  const gap = Math.max(1.2, notes.length / 60);
  const areaCount = new Set(notes.map((note) => note.area.key)).size;
  const slots = notes.length + areaCount * gap;
  const angle = (slot: number) => -Math.PI / 2 + (slot / slots) * TAU;
  let s = gap / 2;
  let arc: CircleArc | undefined;
  for (const note of sorted) {
    if (arc?.area.key !== note.area.key) {
      if (arc) s += gap;
      arc = { area: note.area, t0: angle(s), t1: angle(s) };
      arcs.push(arc);
    }
    const th = angle(s + 0.5);
    pos.set(note.id, { x: Math.cos(th), y: Math.sin(th), th });
    s += 1;
    arc.t1 = angle(s);
  }
  return { pos, arcs, order: sorted.map((note) => note.id) };
}

/** The ring in the canvas above the status line, with room outside it for the radial titles. */
export function fitCircle(width: number, height: number, compact: boolean): { k: number; tx: number; ty: number } {
  const m = Math.min(width, height - CIRCLE_STATUS_BAND);
  const lab = Math.min(170, Math.max(64, m * 0.21));
  return { k: Math.max(40, m / 2 - lab - (compact ? 6 : 16)), tx: width / 2, ty: (height - CIRCLE_STATUS_BAND) / 2 };
}

/** Dot radius in screen pixels; it does not grow with the zoom, so a zoomed ring gains room between the dots. */
export function circleRadius(deg: number): number {
  return Math.min(6.5, 2.6 + Math.sqrt(deg) * 0.9);
}

/**
 * A link as a quadratic chord between two ring notes. Both ends sit 21 px inside the ring, inside the area band; the
 * curve bends toward the centre less the farther apart the notes are. `shift` moves the chord to its own right, so two
 * notes that link to each other keep two visible lines.
 */
export function chordPath(
  a: CirclePoint,
  b: CirclePoint,
  k: number,
  toScreen: (p: { x: number; y: number }) => { x: number; y: number },
  shift: number,
): string {
  const r = 1 - 21 / k;
  const ax = a.x * r,
    ay = a.y * r,
    bx = b.x * r,
    by = b.y * r;
  const diff = Math.abs(a.th - b.th) % TAU;
  const d = Math.min(diff, TAU - diff);
  const pull = (1 - d / Math.PI) * 0.55;
  const mx = (ax + bx) / 2,
    my = (ay + by) / 2;
  const length = Math.hypot(mx, my) || 1;
  const cl = Math.min(length, pull);
  const start = toScreen({ x: ax, y: ay }),
    end = toScreen({ x: bx, y: by });
  const control = toScreen({ x: (mx / length) * cl, y: (my / length) * cl });
  const screenLength = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const nx = (-(end.y - start.y) / screenLength) * shift,
    ny = ((end.x - start.x) / screenLength) * shift;
  return `M${f1(start.x + nx)},${f1(start.y + ny)}Q${f1(control.x + nx)},${f1(control.y + ny)} ${f1(end.x + nx)},${f1(end.y + ny)}`;
}

/**
 * The keyboard along the ring: arrows go to the next or previous note, Page Down to the first note of the next area,
 * Page Up to the first note of the previous area. Both wrap around the ring.
 */
export function ringStep(layout: CircleLayout, areaOf: (id: string) => string, id: string, key: CircleKey): string | null {
  const { order } = layout;
  const index = order.indexOf(id);
  if (index < 0) return null;
  if (key === "PageDown" || key === "PageUp") {
    const starts = order.filter((note, i) => i === 0 || areaOf(note) !== areaOf(order[i - 1]!));
    const areaIndex = starts.findIndex((note) => areaOf(note) === areaOf(id));
    return starts[(areaIndex + (key === "PageDown" ? 1 : -1) + starts.length) % starts.length]!;
  }
  return order[(index + (key === "ArrowRight" || key === "ArrowDown" ? 1 : -1) + order.length) % order.length]!;
}
