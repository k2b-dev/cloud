import { NEIGHBORHOOD_STATUS_BAND } from "./layout-neighborhood";
import type { GraphArea, GraphNote } from "./model";

export const CIRCLE_STATUS_BAND = NEIGHBORHOOD_STATUS_BAND;
export type CirclePoint = { x: number; y: number; th: number };
export type CircleArc = { area: GraphArea; t0: number; t1: number };
/** `step` is the angle of one note slot on the ring. */
export type CircleLayout = { pos: Map<string, CirclePoint>; arcs: CircleArc[]; order: string[]; step: number };
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
  return { pos, arcs, order: sorted.map((note) => note.id), step: slots ? TAU / slots : 0 };
}

/**
 * A note's pointer target: its own slot of the ring, `reach` pixels inside and outside the ring, in coordinates around
 * its dot. The slots of neighbouring notes meet but never overlap, so pressing a dot reaches that note however closely
 * the dots stand.
 */
export function ringTarget(th: number, step: number, k: number, reach: number): string {
  const a0 = th - step / 2,
    a1 = th + step / 2;
  const r0 = Math.max(0, k - reach),
    r1 = k + reach;
  const pt = (r: number, a: number) => `${f1(Math.cos(a) * r - Math.cos(th) * k)},${f1(Math.sin(a) * r - Math.sin(th) * k)}`;
  return `M${pt(r0, a0)}L${pt(r1, a0)}A${f1(r1)},${f1(r1)} 0 0 1 ${pt(r1, a1)}L${pt(r0, a1)}A${f1(r0)},${f1(r0)} 0 0 0 ${pt(r0, a0)}Z`;
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
 * Distances inside the ring, in screen pixels: chord ends, the area band, and the baseline of the area name. They keep
 * the prototype's sizes from a radius of 60 px up and shrink with the ring below it, so a ring zoomed far out still
 * has its chords and bands inside it, never across the centre.
 */
export function circleInsets(k: number) {
  const scale = Math.min(1, k / 60);
  // The name's room is measured at `name`; its baseline sits lower on the lower half, where the text is turned over.
  return { chord: 21 * scale, bandInner: 17 * scale, bandOuter: 11 * scale, name: 28 * scale, upper: 30 * scale, lower: 22 * scale };
}

/**
 * A link as a quadratic chord between two ring notes. Both ends sit `circleInsets(k).chord` inside the ring, inside the area band; the
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
  const r = 1 - circleInsets(k).chord / k;
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
