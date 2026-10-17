import { type NetPoint, nodeRadius } from "./layout-net";

export type GraphView = { k: number; tx: number; ty: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function toScreen(view: GraphView, p: NetPoint): NetPoint {
  return { x: p.x * view.k + view.tx, y: p.y * view.k + view.ty };
}
export function toWorld(view: GraphView, p: NetPoint): NetPoint {
  return { x: (p.x - view.tx) / view.k, y: (p.y - view.ty) / view.k };
}
export function fitView(points: Iterable<NetPoint>, width: number, height: number, compact: boolean): GraphView {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  if (!Number.isFinite(x0)) return { k: 1, tx: width / 2, ty: height / 2 };
  const pad = compact ? 20 : 44;
  const k = clamp(Math.min((width - pad) / (Math.max(1, x1 - x0) + 160), (height - pad) / (Math.max(1, y1 - y0) + 70)), 0.2, 2.2);
  return { k, tx: width / 2 - ((x0 + x1) / 2) * k, ty: height / 2 - ((y0 + y1) / 2) * k };
}
export function zoomView(view: GraphView, factor: number, cx: number, cy: number, fitK: number): GraphView {
  const k = clamp(view.k * factor, fitK * 0.4, fitK * 6);
  const ratio = k / view.k;
  return { k, tx: cx - (cx - view.tx) * ratio, ty: cy - (cy - view.ty) * ratio };
}
export function screenRadius(deg: number, k: number): number {
  return nodeRadius(deg) * clamp(Math.sqrt(k), 0.75, 1.5);
}
export function convexHull(points: readonly NetPoint[]): NetPoint[] {
  const sorted = points.map((point) => ({ ...point })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: NetPoint, a: NetPoint, b: NetPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (items: readonly NetPoint[]) => {
    const result: NetPoint[] = [];
    for (const point of items) {
      while (result.length >= 2) {
        const a = result.at(-2),
          b = result.at(-1);
        if (!a || !b || cross(a, b, point) > 0) break;
        result.pop();
      }
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.toReversed())];
}
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
export function spatialNext(
  from: NetPoint,
  direction: "left" | "right" | "up" | "down",
  candidates: Iterable<{ id: string; point: NetPoint }>,
): string | null {
  const dx = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const dy = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  let best: string | null = null,
    score = Infinity;
  for (const { id, point } of candidates) {
    const vx = point.x - from.x,
      vy = point.y - from.y;
    const along = vx * dx + vy * dy;
    if (along <= 2) continue;
    const candidateScore = along + Math.abs(vx * dy - vy * dx) * 2.2;
    if (candidateScore < score) {
      score = candidateScore;
      best = id;
    }
  }
  return best;
}
