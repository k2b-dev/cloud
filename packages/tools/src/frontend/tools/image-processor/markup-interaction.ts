import type { MarkupElement, MarkupPoint } from "./types";

type MarkupBounds = { x: number; y: number; w: number; h: number };
export type MarkupResizeHandle = "nw" | "ne" | "sw" | "se" | "start" | "end" | "size";
/** Message keys for handle accessibility labels; the rendering component resolves them against its locale. */
export type MarkupHandleLabel =
  | "resizeFromTopLeft"
  | "resizeFromTopRight"
  | "resizeFromBottomLeft"
  | "resizeFromBottomRight"
  | "moveArrowStart"
  | "moveArrowEnd"
  | "resizeCircle"
  | "resizeText";
type MarkupHandle = { id: MarkupResizeHandle; point: MarkupPoint; label: MarkupHandleLabel; cursor: string };

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const toPixels = (point: MarkupPoint, width: number, height: number) => ({ x: point.x * width, y: point.y * height });

const pointSegmentDistance = (point: MarkupPoint, start: MarkupPoint, end: MarkupPoint, width: number, height: number) => {
  const p = toPixels(point, width, height);
  const a = toPixels(start, width, height);
  const b = toPixels(end, width, height);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const rectFromPoints = (start: MarkupPoint, end: MarkupPoint): MarkupBounds => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  w: Math.abs(end.x - start.x),
  h: Math.abs(end.y - start.y),
});

const expandBounds = (bounds: MarkupBounds, x: number, y: number): MarkupBounds => ({
  x: bounds.x - x,
  y: bounds.y - y,
  w: bounds.w + x * 2,
  h: bounds.h + y * 2,
});

const pointInBounds = (point: MarkupPoint, bounds: MarkupBounds, toleranceX = 0, toleranceY = 0) =>
  point.x >= bounds.x - toleranceX &&
  point.x <= bounds.x + bounds.w + toleranceX &&
  point.y >= bounds.y - toleranceY &&
  point.y <= bounds.y + bounds.h + toleranceY;

const pointsEqual = (left: MarkupPoint, right: MarkupPoint) => left.x === right.x && left.y === right.y;

export const markupElementsEqual = (left: MarkupElement, right: MarkupElement): boolean => {
  if (left === right) return true;
  if (left.id !== right.id || left.kind !== right.kind || left.color !== right.color) return false;
  if (left.kind === "stroke" && right.kind === "stroke") {
    return (
      left.size === right.size &&
      left.opacity === right.opacity &&
      left.points.length === right.points.length &&
      left.points.every((point, index) => pointsEqual(point, right.points[index]!))
    );
  }
  if (left.kind === "text" && right.kind === "text") {
    return left.text === right.text && left.size === right.size && pointsEqual(left.position, right.position);
  }
  if (left.kind === "redaction" && right.kind === "redaction") {
    return pointsEqual(left.start, right.start) && pointsEqual(left.end, right.end);
  }
  if (left.kind === "shape" && right.kind === "shape") {
    return (
      left.shape === right.shape && left.size === right.size && pointsEqual(left.start, right.start) && pointsEqual(left.end, right.end)
    );
  }
  return false;
};

export const markupBounds = (element: MarkupElement, width: number, height: number): MarkupBounds => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const minDimension = Math.min(safeWidth, safeHeight);

  if (element.kind === "stroke") {
    const first = element.points[0] ?? { x: 0, y: 0 };
    let minX = first.x;
    let maxX = first.x;
    let minY = first.y;
    let maxY = first.y;
    for (let index = 1; index < element.points.length; index++) {
      const point = element.points[index]!;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    const pad = (element.size * minDimension) / 2;
    return expandBounds({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, pad / safeWidth, pad / safeHeight);
  }

  if (element.kind === "text") {
    const fontSize = Math.max(1, element.size * minDimension);
    const textWidth = Math.max(fontSize * 0.6, element.text.length * fontSize * 0.62);
    return { x: element.position.x, y: element.position.y, w: textWidth / safeWidth, h: (fontSize * 1.2) / safeHeight };
  }

  if (element.kind === "shape" && element.shape === "circle") {
    const center = toPixels(element.start, safeWidth, safeHeight);
    const edge = toPixels(element.end, safeWidth, safeHeight);
    const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
    const pad = (element.size * minDimension) / 2;
    return {
      x: element.start.x - (radius + pad) / safeWidth,
      y: element.start.y - (radius + pad) / safeHeight,
      w: ((radius + pad) * 2) / safeWidth,
      h: ((radius + pad) * 2) / safeHeight,
    };
  }

  const bounds = rectFromPoints(element.start, element.end);
  if (element.kind === "redaction") return bounds;
  const pad = (element.size * minDimension) / 2;
  return expandBounds(bounds, pad / safeWidth, pad / safeHeight);
};

const elementContainsPoint = (element: MarkupElement, point: MarkupPoint, width: number, height: number, tolerancePx: number) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const minDimension = Math.min(safeWidth, safeHeight);
  const toleranceX = tolerancePx / safeWidth;
  const toleranceY = tolerancePx / safeHeight;

  if (element.kind === "stroke") {
    const threshold = tolerancePx + (element.size * minDimension) / 2;
    if (element.points.length === 1) {
      return pointSegmentDistance(point, element.points[0]!, element.points[0]!, safeWidth, safeHeight) <= threshold;
    }
    for (let index = 1; index < element.points.length; index++) {
      if (pointSegmentDistance(point, element.points[index - 1]!, element.points[index]!, safeWidth, safeHeight) <= threshold) return true;
    }
    return false;
  }

  if (element.kind === "text" || element.kind === "redaction") {
    return pointInBounds(point, markupBounds(element, safeWidth, safeHeight), toleranceX, toleranceY);
  }

  if (element.shape === "circle") {
    const center = toPixels(element.start, safeWidth, safeHeight);
    const edge = toPixels(element.end, safeWidth, safeHeight);
    const current = toPixels(point, safeWidth, safeHeight);
    const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
    return Math.hypot(current.x - center.x, current.y - center.y) <= radius + tolerancePx + (element.size * minDimension) / 2;
  }

  if (element.shape === "arrow") {
    return pointSegmentDistance(point, element.start, element.end, safeWidth, safeHeight) <= tolerancePx + element.size * minDimension * 2;
  }

  return pointInBounds(point, markupBounds(element, safeWidth, safeHeight), toleranceX, toleranceY);
};

export const findMarkupAtPoint = (
  elements: MarkupElement[],
  point: MarkupPoint,
  width: number,
  height: number,
  tolerancePx = 6,
  predicate: (element: MarkupElement) => boolean = () => true,
): MarkupElement | null => {
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    if (predicate(element) && elementContainsPoint(element, point, width, height, tolerancePx)) return element;
  }
  return null;
};

export const strokeIdsAtPoint = (elements: MarkupElement[], point: MarkupPoint, width: number, height: number, tolerancePx = 10) =>
  elements
    .filter((element) => element.kind === "stroke" && elementContainsPoint(element, point, width, height, tolerancePx))
    .map((element) => element.id);

export const translateMarkupElement = (element: MarkupElement, delta: MarkupPoint): MarkupElement => {
  const translate = (point: MarkupPoint) => ({ x: point.x + delta.x, y: point.y + delta.y });
  if (element.kind === "stroke") return { ...element, points: element.points.map(translate) };
  if (element.kind === "text") return { ...element, position: translate(element.position) };
  return { ...element, start: translate(element.start), end: translate(element.end) };
};

export const translateMarkupElementInCanvas = (
  element: MarkupElement,
  delta: MarkupPoint,
  width: number,
  height: number,
): MarkupElement => {
  const bounds = markupBounds(element, width, height);
  const isInsideX = bounds.x >= 0 && bounds.x + bounds.w <= 1;
  const isInsideY = bounds.y >= 0 && bounds.y + bounds.h <= 1;
  const constrained = {
    x: isInsideX ? clamp(delta.x, -bounds.x, 1 - bounds.x - bounds.w) : delta.x,
    y: isInsideY ? clamp(delta.y, -bounds.y, 1 - bounds.y - bounds.h) : delta.y,
  };
  return translateMarkupElement(element, constrained);
};

const resizeRect = (
  element: Extract<MarkupElement, { kind: "redaction" | "shape" }>,
  handle: MarkupResizeHandle,
  point: MarkupPoint,
  width: number,
  height: number,
): MarkupElement => {
  const bounds = rectFromPoints(element.start, element.end);
  let left = bounds.x;
  let right = bounds.x + bounds.w;
  let top = bounds.y;
  let bottom = bounds.y + bounds.h;
  if (handle === "nw" || handle === "sw") left = point.x;
  if (handle === "ne" || handle === "se") right = point.x;
  if (handle === "nw" || handle === "ne") top = point.y;
  if (handle === "sw" || handle === "se") bottom = point.y;
  const minWidth = 4 / Math.max(1, width);
  const minHeight = 4 / Math.max(1, height);
  if (right - left < minWidth) {
    if (handle === "nw" || handle === "sw") left = right - minWidth;
    else right = left + minWidth;
  }
  if (bottom - top < minHeight) {
    if (handle === "nw" || handle === "ne") top = bottom - minHeight;
    else bottom = top + minHeight;
  }
  return { ...element, start: { x: left, y: top }, end: { x: right, y: bottom } };
};

export const resizeMarkupElement = (
  element: MarkupElement,
  handle: MarkupResizeHandle,
  point: MarkupPoint,
  width: number,
  height: number,
): MarkupElement => {
  if (element.kind === "redaction" || (element.kind === "shape" && element.shape === "rectangle")) {
    return resizeRect(element, handle, point, width, height);
  }
  if (element.kind === "shape" && element.shape === "arrow") {
    if (handle === "start") return { ...element, start: point };
    if (handle === "end") return { ...element, end: point };
  }
  if (element.kind === "shape" && element.shape === "circle" && handle === "end") {
    return { ...element, end: point };
  }
  if (element.kind === "text" && handle === "size") {
    const minDimension = Math.min(Math.max(1, width), Math.max(1, height));
    const widthPx = Math.max(1, (point.x - element.position.x) * width);
    const heightPx = Math.max(1, (point.y - element.position.y) * height);
    const byWidth = widthPx / Math.max(0.62, element.text.length * 0.62);
    const byHeight = heightPx / 1.2;
    return { ...element, size: clamp(Math.max(byWidth, byHeight) / minDimension, 0.008, 0.25) };
  }
  return element;
};

export const markupHandles = (element: MarkupElement, width: number, height: number): MarkupHandle[] => {
  if (element.kind === "redaction" || (element.kind === "shape" && element.shape === "rectangle")) {
    const bounds = rectFromPoints(element.start, element.end);
    return [
      { id: "nw", point: { x: bounds.x, y: bounds.y }, label: "resizeFromTopLeft", cursor: "nwse-resize" },
      { id: "ne", point: { x: bounds.x + bounds.w, y: bounds.y }, label: "resizeFromTopRight", cursor: "nesw-resize" },
      { id: "sw", point: { x: bounds.x, y: bounds.y + bounds.h }, label: "resizeFromBottomLeft", cursor: "nesw-resize" },
      { id: "se", point: { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, label: "resizeFromBottomRight", cursor: "nwse-resize" },
    ];
  }
  if (element.kind === "shape" && element.shape === "arrow") {
    return [
      { id: "start", point: element.start, label: "moveArrowStart", cursor: "move" },
      { id: "end", point: element.end, label: "moveArrowEnd", cursor: "move" },
    ];
  }
  if (element.kind === "shape" && element.shape === "circle") {
    return [{ id: "end", point: element.end, label: "resizeCircle", cursor: "nwse-resize" }];
  }
  if (element.kind === "text") {
    const bounds = markupBounds(element, width, height);
    return [
      {
        id: "size",
        point: { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
        label: "resizeText",
        cursor: "nwse-resize",
      },
    ];
  }
  return [];
};
