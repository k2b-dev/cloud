import type { ImageEditorAnnotation, ImageEditorPoint, ImageEditorSourceSize } from "./types";

/**
 * Layers are the annotations in drawing order. Redactions are drawn after every other mark, so they form a
 * fixed group on top; reordering only ever happens inside a group. All geometry here is in source pixels.
 */
export type ImageEditorRect = { x: number; y: number; width: number; height: number };

export const isRedaction = (mark: ImageEditorAnnotation) => mark.tool === "redact";

/** Ids are per editing session; a new mark gets the next number, so names stay stable while layers move. */
export const nextAnnotationId = (marks: readonly ImageEditorAnnotation[]) =>
  String(1 + Math.max(0, ...marks.map((mark) => Number(mark.id) || 0)));

/** 1-based number among marks of the same kind, by creation. */
export const annotationNumber = (marks: readonly ImageEditorAnnotation[], mark: ImageEditorAnnotation) =>
  1 + marks.filter((other) => other.tool === mark.tool && (Number(other.id) || 0) < (Number(mark.id) || 0)).length;

export const strokeWidth = (mark: ImageEditorAnnotation, source: ImageEditorSourceSize) =>
  (mark.width * Math.max(source.width, source.height)) / 1000;

let measure: CanvasRenderingContext2D | null | undefined;
const textWidth = (text: string, size: number) => {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * size * 0.56;
  measure.font = `${size}px sans-serif`;
  return measure.measureText(text).width;
};

export function annotationBounds(mark: ImageEditorAnnotation, source: ImageEditorSourceSize): ImageEditorRect {
  const points = mark.points.map((p) => ({ x: p.x * source.width, y: p.y * source.height }));
  const first = points[0] ?? { x: 0, y: 0 };
  const width = strokeWidth(mark, source);
  if (mark.tool === "text") return { x: first.x, y: first.y, width: textWidth(mark.text ?? "", width), height: width * 1.2 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = mark.tool === "redact" ? 0 : mark.tool === "arrow" ? width * 4 : width / 2;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

const segmentDistance = (p: ImageEditorPoint, a: ImageEditorPoint, b: ImageEditorPoint) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Strokes, arrows and outlines are hit near their line; text and redactions anywhere inside. */
function hits(mark: ImageEditorAnnotation, p: ImageEditorPoint, tolerance: number, source: ImageEditorSourceSize) {
  const points = mark.points.map((q) => ({ x: q.x * source.width, y: q.y * source.height }));
  const reach = tolerance + strokeWidth(mark, source) / 2;
  if (mark.tool === "text" || mark.tool === "redact") {
    const b = annotationBounds(mark, source);
    return p.x >= b.x - tolerance && p.x <= b.x + b.width + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.height + tolerance;
  }
  if (mark.tool === "pen" || mark.tool === "highlighter" || mark.tool === "arrow") {
    const line = mark.tool === "arrow" ? [points[0], points.at(-1)] : points;
    if (line.length === 1 && line[0]) return Math.hypot(p.x - line[0].x, p.y - line[0].y) <= reach;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if (a && b && segmentDistance(p, a, b) <= reach) return true;
    }
    return false;
  }
  const a = points[0];
  const b = points.at(-1);
  if (!a || !b) return false;
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (mark.tool === "rect") {
    const outer = p.x >= x0 - reach && p.x <= x1 + reach && p.y >= y0 - reach && p.y <= y1 + reach;
    const inner = p.x > x0 + reach && p.x < x1 - reach && p.y > y0 + reach && p.y < y1 - reach;
    return outer && !inner;
  }
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  if (rx < 1 || ry < 1) return Math.hypot(p.x - (x0 + rx), p.y - (y0 + ry)) <= reach;
  return Math.abs(Math.hypot((p.x - x0 - rx) / rx, (p.y - y0 - ry) / ry) - 1) * Math.min(rx, ry) <= reach;
}

/** The topmost visible layer under a source point, or -1. */
export function hitAnnotation(
  marks: readonly ImageEditorAnnotation[],
  point: ImageEditorPoint,
  tolerance: number,
  source: ImageEditorSourceSize,
): number {
  for (const index of layerOrder(marks)) {
    const mark = marks[index];
    if (mark && !mark.hidden && hits(mark, point, tolerance, source)) return index;
  }
  return -1;
}

/** Array indices from the top layer down: redactions first, then the other marks, each newest first. */
export function layerOrder(marks: readonly ImageEditorAnnotation[]): number[] {
  const indices = marks.map((_, index) => index).reverse();
  return [...indices.filter((i) => marks[i] && isRedaction(marks[i]!)), ...indices.filter((i) => marks[i] && !isRedaction(marks[i]!))];
}

/** Moves a layer one place up (+1) or down (-1) inside its group; returns the same array at a group edge. */
export function stepLayer(marks: readonly ImageEditorAnnotation[], index: number, direction: 1 | -1): readonly ImageEditorAnnotation[] {
  const mark = marks[index];
  if (!mark) return marks;
  const group = marks.map((other, i) => (isRedaction(other) === isRedaction(mark) ? i : -1)).filter((i) => i >= 0);
  const position = group.indexOf(index);
  const target = group[position + direction];
  if (target === undefined) return marks;
  const next = [...marks];
  next[index] = marks[target]!;
  next[target] = mark;
  return next;
}

/** Moves a layer to a place in its group, counted from the top (0 = topmost of the group). */
export function placeLayer(marks: readonly ImageEditorAnnotation[], index: number, fromTop: number): readonly ImageEditorAnnotation[] {
  const mark = marks[index];
  if (!mark) return marks;
  const rest = marks.filter((_, i) => i !== index);
  const group = rest.map((other, i) => (isRedaction(other) === isRedaction(mark) ? i : -1)).filter((i) => i >= 0);
  const clamped = Math.max(0, Math.min(group.length, fromTop));
  // Drawing order runs bottom to top, so the n-th place from the top sits after the group's last (n) members.
  const anchor = group[group.length - clamped];
  const insertAt = anchor === undefined ? (group.at(-1) ?? rest.length - 1) + 1 : anchor;
  return [...rest.slice(0, insertAt), mark, ...rest.slice(insertAt)];
}

export const moveAnnotation = (mark: ImageEditorAnnotation, dx: number, dy: number): ImageEditorAnnotation => ({
  ...mark,
  points: mark.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
});

/** Scales around a fixed source point; text keeps its proportions and scales its size. */
export function scaleAnnotation(
  mark: ImageEditorAnnotation,
  anchor: ImageEditorPoint,
  fx: number,
  fy: number,
  source: ImageEditorSourceSize,
): ImageEditorAnnotation {
  const points = mark.points.map((p) => ({
    x: (anchor.x + (p.x * source.width - anchor.x) * fx) / source.width,
    y: (anchor.y + (p.y * source.height - anchor.y) * fy) / source.height,
  }));
  return mark.tool === "text" ? { ...mark, points, width: Math.max(1, mark.width * fy) } : { ...mark, points };
}
