import { suppressTextSelection, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import GraphFeedback from "./GraphFeedback";
import { convexHull, fitView, type GraphView, type Rect, screenRadius, spatialNext, toScreen, toWorld, zoomView } from "./geometry";
import { createGraphTextMeasure } from "./graph-text-measure";
import { type AreaLabelInput, type LabelKind, type LabelNode, placeLabels } from "./labels";
import { CIRCLE_STATUS_BAND, chordPath, circleInsets, circleRadius, fitCircle, layoutCircle, ringStep } from "./layout-circle";
import {
  fitNeighborhood,
  layoutNeighborhood,
  NEIGHBORHOOD_BOTTOM,
  NEIGHBORHOOD_STATUS_BAND,
  neighborhoodRadius,
} from "./layout-neighborhood";
import type { NetPoint } from "./layout-net";
import { type GraphModel, type GraphModelEdge, type GraphNote, matchesQuery } from "./model";

/** Zoom and fit for the toolbar, which lives outside the canvas. */
export type GraphZoomControls = { zoom: (factor: number) => void; fit: () => void };

export type GraphDisplayProps = {
  model: GraphModel;
  notes: readonly GraphNote[];
  edges: readonly GraphModelEdge[];
  currentId: string | null;
  query: string;
  notebookName: string;
  displayName: string;
  now: string;
  /** Key of the visible set; the view fits again when it changes, not when the search changes. */
  filterKey: string;
  /** Opens a note; `newTab` keeps the graph open, as Cmd/Ctrl+click and middle-click do on a link. */
  onOpen: (id: string, newTab?: boolean) => void;
  onClearQuery: () => void;
  controls: (controls: GraphZoomControls | null) => void;
  /** Search Enter asks the canvas to focus its first match. */
  focusRequest: (focus: (id?: string) => void) => void;
  /** Asked once on mount: true when the canvas replaces a way out that had focus, so focus moves to its tab stop. */
  claimFocus: () => boolean;
};

export type GraphCanvasProps = GraphDisplayProps &
  (
    | { layout: () => Promise<Map<string, NetPoint> | null>; neighborhood?: never; circle?: never }
    | { layout?: never; neighborhood: { depth: 1 | 2; onCentre: (id: string, hadFocus: boolean) => void }; circle?: never }
    | { layout?: never; neighborhood?: never; circle: true }
  );

type ScreenNode = { note: GraphNote; x: number; y: number; r: number };
type Gesture =
  | { type: "pan"; pointerId: number; sx: number; sy: number; view: GraphView; moved: boolean }
  | { type: "node"; pointerId: number; id: string; pointerType: string; sx: number; sy: number; moved: boolean; release?: () => void }
  | { type: "pinch"; distance: number; k: number };

const NEIGHBOUR_FOLLOW = 0.28;
const RECIPROCAL_SHIFT = 2;
const DRAG_THRESHOLD = 4;
const COMPACT_WIDTH = 700;
const f1 = (value: number) => value.toFixed(1);

/**
 * Shared canvas drawing and interaction lifecycle. Network retains its force layout and node dragging;
 * Neighborhood fits its directional rings when the centre, depth, filters or canvas orientation change.
 * Circle places all visible notes on a ring with chords and radial titles.
 * All displays use the same roving focus, pointer gestures, label placement, status and touch selection.
 */
export default function GraphCanvas(props: GraphCanvasProps) {
  const canvasId = createUniqueId();
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  let container!: HTMLDivElement;
  let svg!: SVGSVGElement;

  const [networkPositions, setPositions] = createSignal<Map<string, NetPoint> | null>(null);
  const [revision, setRevision] = createSignal(0);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [view, setView] = createSignal<GraphView>({ k: 1, tx: 0, ty: 0 });
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [focused, setFocused] = createSignal<string | null>(null);
  const [keyboard, setKeyboard] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [tabStop, setTabStop] = createSignal<string | null>(null);
  const [panning, setPanning] = createSignal(false);

  const portrait = () => size().height > size().width * 1.2;
  // The URL state object also changes while typing. A primitive memo keeps search out of layout dependencies.
  const localDepth = createMemo(() => props.neighborhood?.depth ?? 2);
  const localLayout = createMemo(() =>
    props.neighborhood
      ? layoutNeighborhood({
          model: props.model,
          visibleIds: new Set(props.notes.map((note) => note.id)),
          centreId: props.currentId!,
          depth: localDepth(),
          portrait: portrait(),
        })
      : null,
  );
  const circleLayout = createMemo(() => (props.circle ? layoutCircle(props.notes) : null));
  const positions = () => circleLayout()?.pos ?? localLayout()?.pos ?? networkPositions();
  const shownNotes = createMemo(() => {
    const local = localLayout();
    return local ? props.model.notes.filter((note) => local.pos.has(note.id)) : props.notes;
  });
  const drawnEdges = createMemo(() => {
    const local = localLayout();
    return local
      ? props.model.edges.filter((edge) => {
          const a = local.pos.get(edge.source),
            b = local.pos.get(edge.target);
          return a && b && !(a.ring === 2 && b.ring === 2);
        })
      : props.edges;
  });
  const ext = () => (localLayout()?.ring2.length ? localLayout()!.R2 : 1);

  const byId = createMemo(() => new Map(shownNotes().map((note) => [note.id, note])));
  const visiblePoints = () => {
    const all = positions();
    if (!all) return [];
    return shownNotes().flatMap((note) => {
      const point = all.get(note.id);
      return point ? [point] : [];
    });
  };
  const compact = () => size().width < COMPACT_WIDTH;
  const fitted = () =>
    props.neighborhood
      ? fitNeighborhood({ ...size(), ext: ext(), portrait: portrait() })
      : props.circle
        ? fitCircle(size().width, size().height, compact())
        : fitView(visiblePoints(), size().width, size().height, compact());

  // Fit when the canvas gets its size, when the layout arrives, and when the filters change the visible notes.
  createEffect(
    on([positions, size, () => props.filterKey], () => {
      if (!positions() || size().width === 0) return;
      // A queued pan/zoom from the old neighbourhood must not overwrite its newly fitted layout.
      if (props.neighborhood || props.circle) {
        pendingView = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      }
      setView(untrack(fitted));
    }),
  );

  // ---- redraws are throttled to one per frame
  let frame = 0;
  let pendingView: GraphView | null = null;
  let pendingRevision = false;
  const flush = () => {
    frame = 0;
    batch(() => {
      if (pendingView) setView(pendingView);
      if (pendingRevision) setRevision((value) => value + 1);
    });
    pendingView = null;
    pendingRevision = false;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const scheduleView = (next: (current: GraphView) => GraphView) => {
    pendingView = next(pendingView ?? view());
    schedule();
  };
  const zoom = (factor: number, cx = size().width / 2, cy = size().height / 2) =>
    scheduleView((current) => zoomView(current, factor, cx, cy, fitted().k));

  const screen = createMemo(() => {
    revision();
    const all = positions();
    const current = view();
    const nodes = new Map<string, ScreenNode>();
    if (!all || size().width === 0) return nodes;
    for (const note of shownNotes()) {
      const point = all.get(note.id);
      if (!point) continue;
      const projected = toScreen(current, point);
      nodes.set(note.id, {
        note,
        x: projected.x,
        y: projected.y,
        r: props.circle
          ? circleRadius(note.deg)
          : localLayout()
            ? neighborhoodRadius(localLayout()!.pos.get(note.id)!.ring, note.deg)
            : screenRadius(note.deg, current.k),
      });
    }
    return nodes;
  });

  // Keyboard focus wins over a pointer that rests on another note, so the focused note is the one labelled.
  const highlight = () => (keyboard() ? focused() : null) ?? hovered() ?? focused() ?? selected();
  const near = createMemo(() => {
    const id = highlight();
    const note = id ? props.model.byId.get(id) : undefined;
    return note ? new Set([note.id, ...note.neighbours]) : null;
  });

  const hulls = createMemo(() => {
    if (props.neighborhood || props.circle) return [];
    const nodes = screen();
    const pad = Math.max(14, 22 * Math.sqrt(view().k));
    const groups = new Map<number, ScreenNode[]>();
    for (const node of nodes.values()) {
      if (node.note.area.index === 0) continue;
      const group = groups.get(node.note.area.index) ?? [];
      group.push(node);
      groups.set(node.note.area.index, group);
    }
    return [...groups.values()].flatMap((group) => {
      if (group.length < 2) return [];
      const hull = convexHull(group);
      const top = hull.reduce((best, point) => (point.y < best.y ? point : best), hull[0]!);
      const cx = group.reduce((sum, node) => sum + node.x, 0) / group.length;
      const area = group[0]!.note.area;
      return [
        {
          area,
          pad,
          path: `M${hull.map((point) => `${f1(point.x)},${f1(point.y)}`).join("L")}Z`,
          label: { key: area.key, text: area.title || t().untitled, x: (top.x + cx) / 2, y: top.y - pad - 6 } satisfies AreaLabelInput,
        },
      ];
    });
  });

  const { ready: fontsReady, measure } = createGraphTextMeasure(() => svg);

  const bands = createMemo(() =>
    (circleLayout()?.arcs ?? []).map((arc, index) => {
      const { k: R, tx: cx, ty: cy } = view();
      const t0 = arc.t0 + 0.004,
        t1 = arc.t1 - 0.004;
      const big = t1 - t0 > Math.PI ? 1 : 0;
      const pt = (r: number, th: number) => `${f1(cx + Math.cos(th) * r)},${f1(cy + Math.sin(th) * r)}`;
      const inset = circleInsets(R);
      const r0 = R - inset.bandInner,
        r1 = R - inset.bandOuter,
        rt = R - inset.name;
      const name = arc.area.index === 0 ? t().graphTopLevel : arc.area.title || t().untitled;
      const lower = Math.sin((t0 + t1) / 2) > 0.05;
      const rr = R - (lower ? inset.lower : inset.upper);
      // The name sits inside the ring and the titles outside it, so the two never meet; it shows only when it fits.
      const showName = fontsReady() && measure(name, { size: 12, weight: 600 }) + 10 < (t1 - t0) * rt;
      return {
        area: arc.area,
        name,
        id: `${canvasId}-area-${index}`,
        path: `M${pt(r1, t0)}A${f1(r1)},${f1(r1)} 0 ${big} 1 ${pt(r1, t1)}L${pt(r0, t1)}A${f1(r0)},${f1(r0)} 0 ${big} 0 ${pt(r0, t0)}Z`,
        labelPath: lower
          ? `M${pt(rr, t1)}A${f1(rr)},${f1(rr)} 0 ${big} 0 ${pt(rr, t0)}`
          : `M${pt(rr, t0)}A${f1(rr)},${f1(rr)} 0 ${big} 1 ${pt(rr, t1)}`,
        showName,
      };
    }),
  );

  const headings = createMemo(() => {
    const local = localLayout();
    if (!local || !fontsReady()) return [];
    const { width: w, height: h } = size();
    const { tx: cx, ty: cy, k } = view(),
      ay = view().ay ?? 1;
    const head = (x: number, y: number, text: string) => {
      const width = measure(text, { size: 11.5, weight: 600 });
      return { x, y, text, rect: { x0: x - width / 2 - 4, y0: y - 13, x1: x + width / 2 + 4, y1: y + 5 } };
    };
    const outs = t().graphLinksToHeading({ count: local.outs.length });
    const ins = t().graphLinkedFromHeading({ count: local.ins.length });
    const hx = Math.min(k * 1.1, w / 2 - 70),
      y = Math.max(16, cy - k * ext() - 14);
    return [
      ...(local.ins.length ? [portrait() ? head(cx, Math.max(16, cy - k * ay * ext() - 12), ins) : head(cx - hx, y, ins)] : []),
      ...(local.outs.length
        ? [portrait() ? head(cx, Math.min(h - NEIGHBORHOOD_BOTTOM, cy + k * ay * ext() + 22), outs) : head(cx + hx, y, outs)]
        : []),
    ].filter((heading) => heading.rect.x0 >= 2 && heading.rect.x1 <= w - 2 && heading.rect.y0 >= 2 && heading.rect.y1 <= h - 2);
  });

  const labelKind = (note: GraphNote): LabelKind => {
    if (note.id === props.currentId) return "current";
    if (note.id === highlight()) return "hover";
    if (matchesQuery(note, props.query)) return "hit";
    if (near()?.has(note.id)) return "neighbour";
    return localLayout()?.pos.get(note.id)?.ring === 2 ? "far" : "normal";
  };
  const placed = createMemo(() => {
    if (!fontsReady() || size().width === 0) return { labels: [], areaLabels: [] };
    const nodes: LabelNode[] = [...screen().values()].map((node) => {
      const radial = circleLayout()?.pos.get(node.note.id);
      const point = localLayout()?.pos.get(node.note.id);
      const cos = Math.cos(point?.th ?? 0),
        sin = Math.sin(point?.th ?? 0);
      return {
        id: node.note.id,
        title: node.note.title || t().untitled,
        x: node.x,
        y: node.y,
        r: node.r,
        deg: node.note.deg,
        kind: labelKind(node.note),
        ...(radial ? { radial: { cx: view().tx, cy: view().ty, th: radial.th }, maxWidth: compact() ? 130 : 220 } : {}),
        ...(point
          ? {
              priority: point.ring === 1 ? 300 : 0,
              sides:
                point.ring === 0
                  ? (["b"] as const)
                  : cos > 0.25
                    ? (["r", "b", "t"] as const)
                    : cos < -0.25
                      ? (["l", "b", "t"] as const)
                      : sin < 0
                        ? (["t", "r", "l"] as const)
                        : (["b", "r", "l"] as const),
              maxWidth: compact() ? 130 : point.ring === 2 ? 150 : 200,
            }
          : {}),
      };
    });
    return placeLabels({
      width: size().width,
      height: size().height,
      nodes,
      areaLabels: hulls().map((hull) => hull.label),
      bounds: props.circle ? { x0: 2, y0: 2, x1: size().width - 2, y1: size().height - CIRCLE_STATUS_BAND } : undefined,
      measure,
      // The status line covers the bottom of the canvas; the rings leave it free, and so do their labels.
      obstacles: [
        ...headings().map((heading) => heading.rect),
        ...(localLayout() ? [{ x0: 0, y0: size().height - NEIGHBORHOOD_STATUS_BAND, x1: size().width, y1: size().height }] : []),
      ],
      maxLabels: compact() ? 60 : 400,
      maxWidth: compact() ? 130 : 190,
    });
  });

  // ---- focus: the graph is one tab stop; arrows move a roving tab index between the notes
  const tabTarget = () => {
    const stop = tabStop();
    if (stop && byId().has(stop)) return stop;
    if (props.currentId && byId().has(props.currentId)) return props.currentId;
    return shownNotes()[0]?.id ?? null;
  };
  const nodeElement = (id: string) => svg?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`) ?? null;
  const keepInView = (id: string) => {
    const node = screen().get(id);
    if (!node) return;
    const margin = 60;
    const { width, height } = size();
    if (node.x >= margin && node.x <= width - margin && node.y >= margin && node.y <= height - margin) return;
    const current = view();
    setView({ ...current, tx: current.tx + width / 2 - node.x, ty: current.ty + height / 2 - node.y });
  };
  const focusNote = (id: string) => {
    setTabStop(id);
    keepInView(id);
    nodeElement(id)?.focus({ preventScroll: true });
  };

  const centre = (id: string) => {
    if (!props.neighborhood || id === props.currentId) return;
    // Focus on the note, or on the selection bar that disappears now, moves to the new centre, never to the page.
    // When the new centre shows the empty state instead, the display moves focus to its first action.
    const hadFocus = container.contains(document.activeElement);
    setSelected(null);
    props.neighborhood.onCentre(id, hadFocus);
    setTabStop(id);
    if (hadFocus) queueMicrotask(() => container.isConnected && focusNote(id));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const id = (event.target as Element | null)?.closest<SVGGElement>("[data-node]")?.dataset.node;
    // Modified keys stay with the browser, such as Ctrl/Cmd+- and Ctrl/Cmd+0 for page zoom.
    if (!id || event.ctrlKey || event.metaKey || event.altKey) return;
    const ring = circleLayout();
    const ringKey = (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"] as const).find((key) => key === event.key);
    if (ring && ringKey) {
      event.preventDefault();
      const next = ringStep(ring, (noteId) => props.model.byId.get(noteId)!.area.key, id, ringKey);
      if (next) focusNote(next);
      return;
    }
    // Page Down and Page Up go through the notes in page order, so every note is reachable, wherever it lies.
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      const index = shownNotes().findIndex((note) => note.id === id);
      const next = shownNotes()[(index + (event.key === "PageDown" ? 1 : -1) + shownNotes().length) % shownNotes().length];
      if (next) focusNote(next.id);
      return;
    }
    const directions: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const from = screen().get(id);
      if (!from) return;
      const next = spatialNext(
        from,
        direction,
        [...screen().values()].filter((node) => node.note.id !== id).map((node) => ({ id: node.note.id, point: node })),
      );
      if (next) focusNote(next);
      return;
    }
    if (event.key === " " && props.neighborhood) {
      event.preventDefault();
      centre(id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      props.onOpen(id);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (props.currentId && byId().has(props.currentId)) focusNote(props.currentId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (props.query.trim()) props.onClearQuery();
      else (event.target as SVGGElement).blur();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1 / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      setView(fitted());
    }
  };

  // ---- pointers: mouse clicks open, touch and pen taps select; the decision is per gesture, not per screen size
  const pointers = new Map<number, NetPoint>();
  let gesture: Gesture | null = null;
  // A pointer gesture decides on pointerup; the click that follows it is ignored. A click without a pointer gesture
  // just before it comes from assistive technology or voice control, and opens the note like a link.
  const POINTER_CLICK_MS = 1000;
  let pointerClickUntil = Number.NEGATIVE_INFINITY;
  const local = (event: { clientX: number; clientY: number }): NetPoint => {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointerClickUntil = Number.POSITIVE_INFINITY;
    const point = local(event);
    pointers.set(event.pointerId, point);
    svg.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [NetPoint, NetPoint];
      if (gesture?.type === "node") gesture.release?.();
      gesture = { type: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view().k };
      return;
    }
    if (pointers.size > 2) return;
    const id = (event.target as Element).closest<SVGGElement>("[data-node]")?.dataset.node;
    gesture = id
      ? { type: "node", pointerId: event.pointerId, id, pointerType: event.pointerType, sx: event.clientX, sy: event.clientY, moved: false }
      : { type: "pan", pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, view: view(), moved: false };
  };
  const onPointerMove = (event: PointerEvent) => {
    const point = local(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);
    if (!gesture) {
      if (event.pointerType === "mouse") setHovered((event.target as Element).closest<SVGGElement>("[data-node]")?.dataset.node ?? null);
      return;
    }
    if (gesture.type === "pinch") {
      if (pointers.size !== 2) return;
      const [a, b] = [...pointers.values()] as [NetPoint, NetPoint];
      const factor = (gesture.k * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance)) / (pendingView ?? view()).k;
      zoom(factor, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.sx;
    const dy = event.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!gesture.moved && gesture.type === "node") gesture.release = suppressTextSelection(event.pointerId);
    gesture.moved = true;
    if (gesture.type === "pan") {
      setPanning(true);
      const start = gesture.view;
      scheduleView(() => ({ ...start, tx: start.tx + dx, ty: start.ty + dy }));
      return;
    }
    if (props.neighborhood || props.circle) return;
    // Drag: the note follows the pointer and its neighbours follow softly; nothing else moves.
    const all = positions();
    const at = all?.get(gesture.id);
    const note = props.model.byId.get(gesture.id);
    if (!all || !at || !note) return;
    const target = toWorld(pendingView ?? view(), point);
    const mx = target.x - at.x;
    const my = target.y - at.y;
    at.x = target.x;
    at.y = target.y;
    for (const neighbour of note.neighbours) {
      const other = all.get(neighbour);
      if (!other) continue;
      other.x += mx * NEIGHBOUR_FOLLOW;
      other.y += my * NEIGHBOUR_FOLLOW;
    }
    pendingRevision = true;
    schedule();
  };
  const onPointerEnd = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) pointerClickUntil = event.timeStamp + POINTER_CLICK_MS;
    const ended = gesture;
    if (!ended) return;
    if (ended.type === "pinch") {
      if (pointers.size === 0) gesture = null;
      return;
    }
    if (event.pointerId !== ended.pointerId) return;
    gesture = null;
    setPanning(false);
    if (ended.type === "node") ended.release?.();
    if (event.type !== "pointerup" || ended.moved) return;
    if (ended.type === "pan") {
      setSelected(null);
      return;
    }
    if (ended.pointerType === "mouse") props.onOpen(ended.id, event.metaKey || event.ctrlKey || event.shiftKey);
    else {
      // A mouse resting on another note must not keep the highlight from the tapped one.
      setHovered(null);
      setSelected(ended.id);
      setTabStop(ended.id);
    }
  };
  const clickedNode = (event: MouseEvent) => (event.target as Element | null)?.closest<SVGGElement>("[data-node]")?.dataset.node;
  const onClick = (event: MouseEvent) => {
    const id = clickedNode(event);
    if (!id || event.timeStamp <= pointerClickUntil) return;
    event.preventDefault();
    props.onOpen(id, event.metaKey || event.ctrlKey || event.shiftKey);
  };
  // The middle button opens the note in a new tab, as on a link.
  const onAuxClick = (event: MouseEvent) => {
    const id = clickedNode(event);
    if (!id || event.button !== 1) return;
    event.preventDefault();
    props.onOpen(id, true);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const point = local(event);
    zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, point.x, point.y);
  };

  onMount(() => {
    // One headless layout per graph, run in the browser in slices, so the page stays responsive. The canvas never
    // animates: the notes appear once, at their final places.
    let alive = true;
    if (props.layout)
      void props.layout().then((result) => {
        if (alive && result) setPositions(result);
      });
    const resize = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height },
      );
    });
    resize.observe(container);
    svg.addEventListener("wheel", onWheel, { passive: false });
    props.controls({ zoom: (factor) => zoom(factor), fit: () => setView(fitted()) });
    props.focusRequest((id) => {
      const target = id && byId().has(id) ? id : shownNotes().find((note) => matchesQuery(note, props.query))?.id;
      if (target) focusNote(target);
    });
    onCleanup(() => {
      alive = false;
      resize.disconnect();
      svg.removeEventListener("wheel", onWheel);
      props.controls(null);
      if (frame) cancelAnimationFrame(frame);
      if (gesture?.type === "node") gesture.release?.();
    });
  });

  // Focus taken over from an empty state lands on the tab stop once the notes are drawn; the network lays out later.
  let pendingFocus = props.claimFocus();
  createEffect(() => {
    if (!pendingFocus) return;
    const id = tabTarget();
    if (!id || !screen().has(id)) return;
    pendingFocus = false;
    queueMicrotask(() => container.isConnected && focusNote(id));
  });

  // A selection or focus on a note that the filters hid is cleared.
  createEffect(() => {
    const ids = byId();
    if (selected() && !ids.has(selected()!)) setSelected(null);
    if (hovered() && !ids.has(hovered()!)) setHovered(null);
  });

  const nodeLabel = (note: GraphNote) =>
    t().graphNodeLabel({
      title: note.title || t().untitled,
      area: note.area.index === 0 ? null : note.area.title || t().untitled,
      out: note.out.size,
      incoming: note.in.size,
      current: note.id === props.currentId,
    });
  const statusNote = () => {
    const id = highlight();
    return id ? props.model.byId.get(id) : undefined;
  };
  const queryHits = createMemo(() => {
    const query = props.query.trim();
    return query ? shownNotes().filter((note) => matchesQuery(note, query)).length : 0;
  });
  const filteredHits = createMemo(() => (props.query.trim() ? props.notes.filter((note) => matchesQuery(note, props.query)).length : 0));
  const hiddenHits = createMemo(() =>
    props.query.trim() ? props.model.notes.filter((note) => matchesQuery(note, props.query)).length - filteredHits() : 0,
  );
  const idleText = () => {
    const query = props.query.trim();
    if (!positions()) return t().graphArranging({ count: shownNotes().length });
    if (!query) return t().graphNoteCount({ notes: shownNotes().length, links: drawnEdges().length });
    if (queryHits())
      return props.neighborhood && filteredHits() > queryHits()
        ? t().graphNeighborhoodSearchHits({ query, count: queryHits(), total: filteredHits() })
        : t().graphSearchHits({ query, count: queryHits() });
    if (props.neighborhood && filteredHits()) return t().graphNeighborhoodSearchElsewhere({ query, count: filteredHits() });
    return hiddenHits() ? t().graphSearchHidden({ query }) : t().graphSearchNone({ query });
  };
  const edgeNear = (edge: GraphModelEdge) => {
    const id = highlight();
    if (!id) return undefined;
    if (edge.source === id) return "out";
    if (edge.target === id) return "in";
    return undefined;
  };
  const chip = (rect: Rect) => ({ x: rect.x0, y: rect.y0, width: rect.x1 - rect.x0, height: rect.y1 - rect.y0 });

  return (
    <div
      ref={container}
      class="absolute inset-0"
      onFocusIn={(event) => {
        const id = (event.target as Element).closest<SVGGElement>("[data-node]")?.dataset.node;
        if (!id) return;
        setTabStop(id);
        // A pointer press also focuses a note; only keyboard focus highlights, so clearing a touch selection clears it.
        const visible = (event.target as Element).matches(":focus-visible");
        setFocused(visible ? id : null);
        setKeyboard(visible);
        if (visible) setHovered(null);
      }}
      onFocusOut={(event) => {
        if (container.contains(event.relatedTarget as Node | null)) return;
        setFocused(null);
        setKeyboard(false);
      }}
    >
      <svg
        ref={svg}
        class="notebook-graph__svg"
        data-display={props.circle ? "circle" : props.neighborhood ? "neighborhood" : "network"}
        role="group"
        aria-label={t().graphGroupLabel({ notebook: props.notebookName, display: props.displayName, count: shownNotes().length })}
        data-highlight={highlight() ? "" : undefined}
        data-query={props.query.trim() ? "" : undefined}
        data-panning={panning() ? "" : undefined}
        data-slot={statusNote()?.area.slot}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && !gesture) setHovered(null);
        }}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onAuxClick={onAuxClick}
      >
        <g aria-hidden="true">
          <Show when={localLayout()}>
            <ellipse class="notebook-graph__orbit" cx={view().tx} cy={view().ty} rx={view().k} ry={view().k * (view().ay ?? 1)} />
            <Show when={localLayout()!.ring2.length > 0}>
              <ellipse
                class="notebook-graph__orbit"
                data-orbit="2"
                cx={view().tx}
                cy={view().ty}
                rx={view().k * ext()}
                ry={view().k * (view().ay ?? 1) * ext()}
                stroke-dasharray="2 4"
              />
            </Show>
            <For each={headings()}>
              {(heading) => (
                <text class="notebook-graph__heading" x={heading.x} y={heading.y} text-anchor="middle">
                  {heading.text}
                </text>
              )}
            </For>
          </Show>
          <For each={bands()}>{(band) => <path class="notebook-graph__band" data-slot={band.area.slot} d={band.path} />}</For>
          <For each={hulls()}>
            {(hull) => <path class="notebook-graph__hull" data-slot={hull.area.slot} d={hull.path} stroke-width={f1(hull.pad * 2)} />}
          </For>
        </g>
        <g aria-hidden="true">
          <For each={drawnEdges()}>
            {(edge) => {
              // Two notes that link to each other get two parallel lines, each shifted to its own right, so a
              // dashed incoming line never hides under the solid outgoing one.
              const shift = props.model.byId.get(edge.target)?.out.has(edge.source) ? RECIPROCAL_SHIFT : 0;
              const d = () => {
                const a = screen().get(edge.source);
                const b = screen().get(edge.target);
                if (!a || !b) return "";
                const ca = circleLayout()?.pos.get(edge.source),
                  cb = circleLayout()?.pos.get(edge.target);
                if (ca && cb) return chordPath(ca, cb, view().k, (p) => toScreen(view(), p), shift);
                const pa = localLayout()?.pos.get(edge.source),
                  pb = localLayout()?.pos.get(edge.target);
                const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
                const nx = (-(b.y - a.y) / length) * shift;
                const ny = ((b.x - a.x) / length) * shift;
                // Links between first-ring notes curve towards the centre; a reciprocal pair shifts the whole curve.
                if (pa?.ring === 1 && pb?.ring === 1) {
                  const control = toScreen(view(), { x: ((pa.x + pb.x) / 2) * 0.45, y: ((pa.y + pb.y) / 2) * 0.45 });
                  return `M${f1(a.x + nx)},${f1(a.y + ny)}Q${f1(control.x + nx)},${f1(control.y + ny)} ${f1(b.x + nx)},${f1(b.y + ny)}`;
                }
                return `M${f1(a.x + nx)},${f1(a.y + ny)}L${f1(b.x + nx)},${f1(b.y + ny)}`;
              };
              const edgeClass = () => {
                if (props.circle) return "chord";
                const a = localLayout()?.pos.get(edge.source),
                  b = localLayout()?.pos.get(edge.target);
                return !a || !b ? undefined : a.ring === 0 || b.ring === 0 ? "centre" : a.ring === 1 && b.ring === 1 ? "cross" : "far";
              };
              // A chord takes the colour of the area it starts from; a centre link the colour of the other note.
              const edgeSlot = () =>
                props.circle
                  ? props.model.byId.get(edge.source)?.area.slot
                  : edgeClass() === "centre"
                    ? props.model.byId.get(edge.source === props.currentId ? edge.target : edge.source)?.area.slot
                    : undefined;
              return (
                <path
                  data-edge-kind={edgeClass()}
                  data-slot={edgeSlot()}
                  class="notebook-graph__edge"
                  data-source={edge.source}
                  data-target={edge.target}
                  data-near={edgeNear(edge)}
                  d={d()}
                />
              );
            }}
          </For>
        </g>
        <g aria-hidden="true">
          <For each={bands()}>
            {(band) => (
              <Show when={band.showName}>
                <path id={band.id} d={band.labelPath} fill="none" />
                <text class="notebook-graph__band-label" data-slot={band.area.slot} data-area={band.area.key}>
                  <textPath href={`#${band.id}`} startOffset="50%" text-anchor="middle">
                    {band.name}
                  </textPath>
                </text>
              </Show>
            )}
          </For>
          <For each={placed().areaLabels}>
            {(label) => {
              const slot = hulls().find((hull) => hull.area.key === label.key)?.area.slot ?? 0;
              return (
                <text class="notebook-graph__area-label" data-slot={slot} x={f1(label.x)} y={f1(label.y)} text-anchor="middle">
                  {label.text}
                </text>
              );
            }}
          </For>
        </g>
        <g>
          <For each={shownNotes()}>
            {(note) => {
              const node = () => screen().get(note.id);
              const current = () => note.id === props.currentId;
              return (
                <Show when={node()}>
                  {(at) => (
                    <g
                      class="notebook-graph__node"
                      data-node={note.id}
                      data-ring={localLayout()?.pos.get(note.id)?.ring}
                      data-slot={note.area.slot}
                      data-orphan={note.orphan ? "" : undefined}
                      data-current={current() ? "" : undefined}
                      data-near={near()?.has(note.id) ? "" : undefined}
                      data-match={matchesQuery(note, props.query) ? "" : undefined}
                      role="link"
                      tabindex={tabTarget() === note.id ? 0 : -1}
                      aria-label={nodeLabel(note)}
                      aria-current={current() ? "page" : undefined}
                      transform={`translate(${f1(at().x)},${f1(at().y)})`}
                    >
                      <circle class="notebook-graph__hit" r={Math.max(at().r + 6, 12)} />
                      <Show when={current()}>
                        <circle class="notebook-graph__ring" r={f1(at().r + 4)} />
                      </Show>
                      <circle class="notebook-graph__match" r={f1(at().r + 3)} />
                      <circle class="notebook-graph__disc" r={f1(at().r)} />
                      <circle class="notebook-graph__focus" r={f1(at().r + (current() ? 7.5 : 4))} />
                    </g>
                  )}
                </Show>
              );
            }}
          </For>
        </g>
        <g aria-hidden="true">
          <For each={placed().labels}>
            {(label) => (
              <>
                <Show when={label.chip}>{(rect) => <rect class="notebook-graph__chip" rx="6" {...chip(rect())} />}</Show>
                <text
                  class="notebook-graph__label"
                  data-label={label.id}
                  data-kind={label.kind}
                  data-near={near()?.has(label.id) ? "" : undefined}
                  x={f1(label.x)}
                  y={f1(label.y)}
                  dy="0.34em"
                  text-anchor={label.anchor}
                  transform={label.rotate === undefined ? undefined : `rotate(${f1(label.rotate)} ${f1(label.x)} ${f1(label.y)})`}
                >
                  {label.text}
                </text>
              </>
            )}
          </For>
        </g>
      </svg>
      <GraphFeedback
        statusNote={statusNote()}
        selected={selected() ? props.model.byId.get(selected()!) : undefined}
        currentId={props.currentId}
        keyboard={keyboard()}
        now={props.now}
        idleText={idleText()}
        onOpen={props.onOpen}
        onClearSelection={() => setSelected(null)}
        onCentre={props.neighborhood ? centre : undefined}
        pointerHints={props.circle || props.neighborhood ? t().graphFixedPointerHints : t().graphPointerHints}
        areaKeys={props.circle}
      />
    </div>
  );
}
