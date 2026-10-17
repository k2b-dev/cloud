import { type Rect, rectsIntersect } from "./geometry";

export type LabelKind = "current" | "hover" | "hit" | "neighbour" | "normal" | "far";
export type LabelFont = { size: number; weight: number };
export const LABEL_FONTS: Record<LabelKind, LabelFont> = {
  current: { size: 13, weight: 700 },
  hover: { size: 12, weight: 600 },
  hit: { size: 12, weight: 700 },
  neighbour: { size: 12, weight: 600 },
  far: { size: 11, weight: 400 },
  normal: { size: 12, weight: 400 },
};
export type LabelSide = "r" | "l" | "b" | "t";
export type LabelNode = {
  id: string;
  title: string;
  x: number;
  y: number;
  r: number;
  deg: number;
  kind: LabelKind;
  sides?: readonly LabelSide[];
  maxWidth?: number;
  priority?: number;
};
export type AreaLabelInput = { key: string; text: string; x: number; y: number };
export type PlacedLabel = {
  id: string;
  text: string;
  kind: LabelKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rect: Rect;
  chip: Rect | null;
};
export type PlacedAreaLabel = { key: string; text: string; x: number; y: number; rect: Rect };
export type Measure = (text: string, font: LabelFont) => number;

export function fitText(text: string, maxWidth: number, font: LabelFont, measure: Measure): string {
  if (measure(text, font) <= maxWidth) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo < 3 ? "" : `${text.slice(0, lo).trimEnd()}…`;
}
const priority: Record<LabelKind, number> = { current: 1000, hover: 900, hit: 700, neighbour: 500, normal: 0, far: 0 };
const forcedRank = (kind: LabelKind) => (kind === "current" ? 2 : kind === "hover" ? 1 : 0);
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });

export function placeLabels(input: {
  width: number;
  height: number;
  nodes: readonly LabelNode[];
  areaLabels: readonly AreaLabelInput[];
  measure: Measure;
  maxLabels: number;
  maxWidth: number;
  obstacles?: readonly Rect[];
}): { labels: PlacedLabel[]; areaLabels: PlacedAreaLabel[] } {
  const { width, height, measure } = input;
  const inside = (r: Rect) => r.x0 >= 2 && r.y0 >= 2 && r.x1 <= width - 2 && r.y1 <= height - 2;
  let areaLabels: PlacedAreaLabel[] = [];
  for (const area of input.areaLabels) {
    const w = measure(area.text, { size: 12, weight: 600 });
    const bounds = rect(area.x - w / 2 - 4, area.y - 14, w + 8, 18);
    if (inside(bounds) && !areaLabels.some((other) => rectsIntersect(bounds, other.rect))) areaLabels.push({ ...area, rect: bounds });
  }
  const obstacles = input.nodes.map((node) => rect(node.x - node.r - 1, node.y - node.r - 1, (node.r + 1) * 2, (node.r + 1) * 2));
  const labels: PlacedLabel[] = [];
  const labelFree = (r: Rect) =>
    !labels.some((label) => rectsIntersect(r, label.rect)) && !(input.obstacles ?? []).some((other) => rectsIntersect(r, other));
  const free = (r: Rect) =>
    labelFree(r) && !obstacles.some((other) => rectsIntersect(r, other)) && !areaLabels.some((other) => rectsIntersect(r, other.rect));
  const nodes = input.nodes
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        forcedRank(b.node.kind) - forcedRank(a.node.kind) ||
        b.node.deg + (b.node.priority ?? 0) + priority[b.node.kind] - (a.node.deg + (a.node.priority ?? 0) + priority[a.node.kind]) ||
        a.index - b.index,
    );
  let count = 0;
  for (const { node } of nodes) {
    // Partially visible dots can still have labels; fully off-canvas circles cannot.
    if (node.x + node.r < 0 || node.x - node.r > width || node.y + node.r < 0 || node.y - node.r > height) continue;
    const forced = forcedRank(node.kind) > 0;
    if (!forced && count >= input.maxLabels) continue;
    const font = LABEL_FONTS[node.kind];
    const current = node.kind === "current";
    const paddingX = current ? 5 : 2,
      paddingY = current ? 2 : 0;
    const text = fitText(node.title, Math.min(node.maxWidth ?? input.maxWidth, width - 4 - paddingX * 2), font, measure);
    if (!text) continue;
    const w = measure(text, font),
      h = font.size + 4;
    const gap = node.r + 5;
    const sides: Record<LabelSide, { x: number; y: number }> = {
      r: { x: node.x + gap, y: node.y - h / 2 },
      l: { x: node.x - gap - w, y: node.y - h / 2 },
      b: { x: node.x - w / 2, y: node.y + gap },
      t: { x: node.x - w / 2, y: node.y - gap - h },
    };
    const candidates = (node.sides ?? (["r", "l", "b", "t"] as const))
      .map((side) => sides[side])
      .map(({ x, y }) => rect(x - paddingX, y - paddingY, w + paddingX * 2, h + paddingY * 2));
    let bounds = candidates.find((candidate) => inside(candidate) && free(candidate));
    if (!bounds && forced) {
      bounds = candidates.find((candidate) => inside(candidate) && labelFree(candidate));
      if (!bounds) {
        const rw = w + paddingX * 2,
          rh = h + paddingY * 2;
        // Clamp into the canvas. If the other forced label occupies that spot,
        // try its boundaries too; this preserves both labels even on an edge.
        const clampX = (x: number) => Math.max(2, Math.min(width - 2 - rw, x));
        const clampY = (y: number) => Math.max(2, Math.min(height - 2 - rh, y));
        const positions = candidates.map((candidate) => rect(clampX(candidate.x0), clampY(candidate.y0), rw, rh));
        const first = positions[0];
        if (first) {
          const xs = [first.x0, 2, width - 2 - rw, ...labels.flatMap((label) => [label.rect.x0 - rw, label.rect.x1])];
          const ys = [first.y0, 2, height - 2 - rh, ...labels.flatMap((label) => [label.rect.y0 - rh, label.rect.y1])];
          for (const y of ys) for (const x of xs) positions.push(rect(clampX(x), clampY(y), rw, rh));
        }
        bounds = positions.find((candidate) => inside(candidate) && labelFree(candidate));
      }
    }
    if (!bounds) continue;
    if (forced) areaLabels = areaLabels.filter((area) => !rectsIntersect(bounds, area.rect));
    labels.push({
      id: node.id,
      text,
      kind: node.kind,
      x: bounds.x0 + paddingX,
      y: bounds.y0 + paddingY + h / 2,
      width: w,
      height: h,
      rect: bounds,
      chip: current ? bounds : null,
    });
    if (!forced) count++;
  }
  return { labels, areaLabels };
}
