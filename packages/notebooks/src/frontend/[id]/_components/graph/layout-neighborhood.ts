import type { GraphModel, GraphNote } from "./model";

export type NeighborhoodPoint = { x: number; y: number; ring: 0 | 1 | 2; th: number };
export type NeighborhoodLayout = { pos: Map<string, NeighborhoodPoint>; outs: string[]; ins: string[]; ring2: string[]; R2: number };
const TAU = 2 * Math.PI;

/** The prototype's directional first ring and circular-mean second ring, in unit coordinates. */
export function layoutNeighborhood(input: {
  model: GraphModel;
  visibleIds: ReadonlySet<string>;
  centreId: string;
  depth: 1 | 2;
  portrait: boolean;
}): NeighborhoodLayout {
  const { model, visibleIds, centreId, depth, portrait } = input;
  const centre = model.byId.get(centreId);
  const pos = new Map<string, NeighborhoodPoint>([[centreId, { x: 0, y: 0, ring: 0, th: 0 }]]);
  const sort = (ids: Iterable<string>) =>
    [...ids]
      .flatMap((id) => {
        const note = visibleIds.has(id) ? model.byId.get(id) : undefined;
        return note ? [note] : [];
      })
      .sort((a, b) => a.area.index - b.area.index || a.order - b.order);
  const outs = sort(centre?.out ?? []);
  const ins = sort([...(centre?.in ?? [])].filter((id) => !centre?.out.has(id)));
  const spread = (notes: GraphNote[], mid: number, maxSpan: number) => {
    const span = Math.min(maxSpan, Math.max(0, notes.length - 1) * 0.36);
    notes.forEach((note, i) => {
      const th = notes.length < 2 ? mid : mid - span / 2 + (i / (notes.length - 1)) * span;
      pos.set(note.id, { x: Math.cos(th), y: Math.sin(th), ring: 1, th });
    });
  };
  if (portrait) {
    outs.reverse();
    spread(outs, Math.PI / 2, Math.PI * 0.8);
    spread(ins, -Math.PI / 2, Math.PI * 0.8);
  } else {
    ins.reverse();
    spread(outs, 0, Math.PI * 0.86);
    spread(ins, Math.PI, Math.PI * 0.86);
  }
  const R2 = 1.75;
  const ring2: string[] = [];
  if (depth === 2) {
    const ring1 = [...outs, ...ins];
    const firstIds = new Set(ring1.map((note) => note.id));
    const candidates = new Map<string, number[]>();
    for (const note of ring1)
      for (const id of note.neighbours) {
        if (id === centreId || firstIds.has(id) || !visibleIds.has(id)) continue;
        const angles = candidates.get(id) ?? [];
        angles.push(pos.get(note.id)!.th);
        candidates.set(id, angles);
      }
    const items = [...candidates]
      .map(([id, angles]) => ({
        id,
        th: Math.atan2(
          angles.reduce((sum, th) => sum + Math.sin(th), 0),
          angles.reduce((sum, th) => sum + Math.cos(th), 0),
        ),
      }))
      .sort((a, b) => a.th - b.th || model.byId.get(a.id)!.order - model.byId.get(b.id)!.order);
    const minGap = Math.min(0.22, TAU / Math.max(1, items.length));
    for (let pass = 0; pass < 40; pass++) {
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1]!,
          b = items[i]!;
        const d = b.th - a.th;
        if (d < minGap) {
          const push = (minGap - d) / 2;
          b.th += push;
          a.th -= push;
        }
      }
      if (items.length > 1) {
        const a = items[0]!,
          b = items[items.length - 1]!;
        const d = a.th + TAU - b.th;
        if (d < minGap) {
          const push = (minGap - d) / 2;
          a.th += push;
          b.th -= push;
        }
      }
    }
    // Forty relaxation passes can leave a crowded cluster compressed. A bounded O(n) projection guarantees
    // the gap: unwrap at the largest circular gap, push forward, then (only if the wrap gap still fails)
    // spread uniformly about the relaxed mean. The sparse, already-converged prototype result stays intact.
    const angularOrder = items.toSorted((a, b) => a.th - b.th || model.byId.get(a.id)!.order - model.byId.get(b.id)!.order);
    const compressed = angularOrder.some(
      (item, i) => angularOrder[(i + 1) % items.length]!.th + (i === items.length - 1 ? TAU : 0) - item.th < minGap - 1e-12,
    );
    if (items.length > 1 && compressed) {
      let cut = 0,
        largest = -Infinity;
      for (let i = 0; i < items.length; i++) {
        const gap = angularOrder[(i + 1) % items.length]!.th + (i === items.length - 1 ? TAU : 0) - angularOrder[i]!.th;
        if (gap > largest) {
          largest = gap;
          cut = (i + 1) % items.length;
        }
      }
      const ordered = [...angularOrder.slice(cut), ...angularOrder.slice(0, cut)];
      for (const item of ordered.slice(items.length - cut)) item.th += TAU;
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1]!,
          b = ordered[i]!;
        b.th = Math.max(b.th, a.th + minGap);
      }
      if (ordered[0]!.th + TAU - ordered[ordered.length - 1]!.th < minGap - 1e-12) {
        const mean = ordered.reduce((sum, item) => sum + item.th, 0) / ordered.length;
        ordered.forEach((item, i) => {
          item.th = mean + ((i - (ordered.length - 1) / 2) * TAU) / ordered.length;
        });
      }
    }
    for (const item of items) {
      pos.set(item.id, { x: Math.cos(item.th) * R2, y: Math.sin(item.th) * R2, ring: 2, th: item.th });
      ring2.push(item.id);
    }
  }
  return { pos, outs: outs.map((note) => note.id), ins: ins.map((note) => note.id), ring2, R2 };
}

export type NeighborhoodView = { k: number; ay: number; tx: number; ty: number };
/** Room above the outer ring for a ring heading. */
export const NEIGHBORHOOD_TOP = 30;
/** Room below the outer ring: the status line sits over the bottom of the canvas. */
export const NEIGHBORHOOD_BOTTOM = 40;
/** The bottom band that the status line covers; labels stay out of it. */
export const NEIGHBORHOOD_STATUS_BAND = 34;
/**
 * Fits the rings into the canvas: a circle in landscape, an upright ellipse in portrait so the tall phone screen is
 * used. Above the rings stays room for the headings, below them room for the headings and the status line.
 */
export function fitNeighborhood({
  width: w,
  height: h,
  ext,
  portrait,
}: {
  width: number;
  height: number;
  ext: number;
  portrait: boolean;
}): NeighborhoodView {
  if (portrait) {
    // The headings sit above and below the ellipse, so the outer ring leaves room for them on both sides.
    const extent = (h - NEIGHBORHOOD_TOP - NEIGHBORHOOD_BOTTOM - 36) / 2;
    const k = Math.max(40, (w / 2 - Math.min(110, w * 0.26)) / ext);
    return { k, ay: Math.min(2.6, Math.max(1, extent / ext / k)), tx: w / 2, ty: NEIGHBORHOOD_TOP + 12 + extent };
  }
  const lab = Math.min(190, Math.max(70, w * 0.17));
  const extent = (h - NEIGHBORHOOD_TOP - NEIGHBORHOOD_BOTTOM) / 2;
  const R = Math.min((w / 2 - lab - 12) / ext, extent / ext);
  return { k: Math.max(40, R), ay: 1, tx: w / 2, ty: NEIGHBORHOOD_TOP + extent };
}
export function neighborhoodRadius(ring: 0 | 1 | 2, deg: number): number {
  return ring === 0 ? 11 : ring === 1 ? Math.min(8, 4.5 + Math.sqrt(deg) * 0.8) : 3.6;
}
