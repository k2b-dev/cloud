import type { LineStyle } from "./svg-common";
import { fmt } from "./svg-format";

export const linePathD = (points: ReadonlyArray<{ x: number; y: number }>): string => {
  if (points.length === 0) return "";
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`;
  }
  return d;
};

export const smoothPathD = (points: ReadonlyArray<{ x: number; y: number }>): string => {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  if (n === 2) return linePathD(points);

  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? points[i - 1]! : points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = i + 2 < n ? points[i + 2]! : points[i + 1]!;
    const dx = p2.x - p1.x;
    const cp1x = p1.x + dx / 3;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - dx / 3;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(cp1x)} ${fmt(cp1y)} ${fmt(cp2x)} ${fmt(cp2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
};

export const stepPathD = (points: ReadonlyArray<{ x: number; y: number }>, mode: "before" | "after" | "middle"): string => {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;

  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    if (mode === "before") {
      // step at next-x: extend horizontally to new x at OLD y, then jump to new y.
      d += ` L ${fmt(p.x)} ${fmt(prev.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    } else if (mode === "after") {
      // step at current-x: jump to new y immediately, persist until next x.
      d += ` L ${fmt(prev.x)} ${fmt(p.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    } else {
      // middle: step at midpoint of x.
      const mx = (prev.x + p.x) / 2;
      d += ` L ${fmt(mx)} ${fmt(prev.y)} L ${fmt(mx)} ${fmt(p.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    }
  }
  return d;
};

export const DEFAULT_LINE_STYLES: readonly LineStyle[] = ["solid", "dashed", "dotted", "dashdot"];

/** SVG `stroke-dasharray` values per line style. Empty string = no dasharray. */
export const LINE_DASH_PATTERNS: Record<LineStyle, string> = {
  solid: "",
  dashed: "6 4",
  dotted: "2 3",
  dashdot: "6 3 2 3",
};
