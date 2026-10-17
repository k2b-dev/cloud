import { Button, Format, IconButton, Kbd, suppressTextSelection, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import { convexHull, fitView, type GraphView, type Rect, screenRadius, spatialNext, toScreen, toWorld, zoomView } from "./geometry";
import { type AreaLabelInput, type LabelFont, type LabelKind, type LabelNode, placeLabels } from "./labels";
import { layoutNetworkInSlices, type NetPoint } from "./layout-net";
import { type GraphModel, type GraphModelEdge, type GraphNote, matchesQuery } from "./model";

/** Zoom and fit for the toolbar, which lives outside the canvas. */
export type GraphZoomControls = { zoom: (factor: number) => void; fit: () => void };

type Props = {
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
  onOpen: (id: string) => void;
  onClearQuery: () => void;
  controls: (controls: GraphZoomControls | null) => void;
  /** Search Enter asks the canvas to focus its first match. */
  focusRequest: (focus: (id: string) => void) => void;
};

type ScreenNode = { note: GraphNote; x: number; y: number; r: number };
type Gesture =
  | { type: "pan"; pointerId: number; sx: number; sy: number; view: GraphView; moved: boolean }
  | { type: "node"; pointerId: number; id: string; pointerType: string; sx: number; sy: number; moved: boolean; release?: () => void }
  | { type: "pinch"; distance: number; k: number };

const NEIGHBOUR_FOLLOW = 0.28;
const DRAG_THRESHOLD = 4;
const COMPACT_WIDTH = 700;
const f1 = (value: number) => value.toFixed(1);

/**
 * The Network display: the whole notebook as a calm network. The layout is computed once in the browser and never
 * moves by itself; only a drag moves a note, and its direct neighbours follow a little. Labels are placed after the
 * fonts load, in priority order, and never overlap.
 */
export default function NetworkDisplay(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  let container!: HTMLDivElement;
  let svg!: SVGSVGElement;

  const [positions, setPositions] = createSignal<Map<string, NetPoint> | null>(null);
  const [revision, setRevision] = createSignal(0);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [view, setView] = createSignal<GraphView>({ k: 1, tx: 0, ty: 0 });
  const [fontsReady, setFontsReady] = createSignal(false);
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [focused, setFocused] = createSignal<string | null>(null);
  const [keyboard, setKeyboard] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [tabStop, setTabStop] = createSignal<string | null>(null);
  const [panning, setPanning] = createSignal(false);

  const byId = createMemo(() => new Map(props.notes.map((note) => [note.id, note])));
  const visiblePoints = () => {
    const all = positions();
    if (!all) return [];
    return props.notes.flatMap((note) => {
      const point = all.get(note.id);
      return point ? [point] : [];
    });
  };
  const compact = () => size().width < COMPACT_WIDTH;
  const fitted = () => fitView(visiblePoints(), size().width, size().height, compact());

  // Fit when the canvas gets its size, when the layout arrives, and when the filters change the visible notes.
  createEffect(
    on([positions, size, () => props.filterKey], () => {
      if (!positions() || size().width === 0) return;
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
    if (!all) return nodes;
    for (const note of props.notes) {
      const point = all.get(note.id);
      if (!point) continue;
      const projected = toScreen(current, point);
      nodes.set(note.id, { note, x: projected.x, y: projected.y, r: screenRadius(note.deg, current.k) });
    }
    return nodes;
  });

  const highlight = () => hovered() ?? focused() ?? selected();
  const near = createMemo(() => {
    const id = highlight();
    const note = id ? props.model.byId.get(id) : undefined;
    return note ? new Set([note.id, ...note.neighbours]) : null;
  });

  const hulls = createMemo(() => {
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
          label: { key: area.key, text: area.title ?? "", x: (top.x + cx) / 2, y: top.y - pad - 6 } satisfies AreaLabelInput,
        },
      ];
    });
  });

  // ---- text measurement with the canvas font, after the fonts have loaded
  let context: CanvasRenderingContext2D | null = null;
  let family = "sans-serif";
  const widths = new Map<string, number>();
  const measure = (text: string, font: LabelFont) => {
    const key = `${font.weight}|${font.size}|${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      if (!context) return text.length * font.size * 0.6;
      context.font = `${font.weight} ${font.size}px ${family}`;
      width = context.measureText(text).width;
      widths.set(key, width);
    }
    return width;
  };

  const labelKind = (note: GraphNote): LabelKind => {
    if (note.id === props.currentId) return "current";
    if (note.id === highlight()) return "hover";
    if (matchesQuery(note, props.query)) return "hit";
    if (near()?.has(note.id)) return "neighbour";
    return "normal";
  };
  const placed = createMemo(() => {
    if (!fontsReady() || size().width === 0) return { labels: [], areaLabels: [] };
    const nodes: LabelNode[] = [...screen().values()].map((node) => ({
      id: node.note.id,
      title: node.note.title,
      x: node.x,
      y: node.y,
      r: node.r,
      deg: node.note.deg,
      kind: labelKind(node.note),
    }));
    return placeLabels({
      width: size().width,
      height: size().height,
      nodes,
      areaLabels: hulls().map((hull) => hull.label),
      measure,
      maxLabels: compact() ? 60 : 400,
      maxWidth: compact() ? 130 : 190,
    });
  });

  // ---- focus: the graph is one tab stop; arrows move a roving tab index between the notes
  const tabTarget = () => {
    const stop = tabStop();
    if (stop && byId().has(stop)) return stop;
    if (props.currentId && byId().has(props.currentId)) return props.currentId;
    return props.notes[0]?.id ?? null;
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

  const onKeyDown = (event: KeyboardEvent) => {
    const id = (event.target as Element | null)?.closest<SVGGElement>("[data-node]")?.dataset.node;
    // Modified keys stay with the browser, such as Ctrl/Cmd+- and Ctrl/Cmd+0 for page zoom.
    if (!id || event.ctrlKey || event.metaKey || event.altKey) return;
    // Page Down and Page Up go through the notes in page order, so every note is reachable, wherever it lies.
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      const index = props.notes.findIndex((note) => note.id === id);
      const next = props.notes[(index + (event.key === "PageDown" ? 1 : -1) + props.notes.length) % props.notes.length];
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
  const local = (event: { clientX: number; clientY: number }): NetPoint => {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
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
    if (ended.pointerType === "mouse") props.onOpen(ended.id);
    else {
      setSelected(ended.id);
      setTabStop(ended.id);
    }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const point = local(event);
    zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, point.x, point.y);
  };

  onMount(() => {
    // One headless layout per graph, run in the browser in slices, so the page stays responsive. The canvas never
    // animates: the notes appear once, at their final places.
    const layout = new AbortController();
    void layoutNetworkInSlices(props.model, layout.signal).then((result) => {
      if (result) setPositions(result);
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
      if (byId().has(id)) focusNote(id);
    });
    let alive = true;
    void document.fonts.ready.then(() => {
      if (!alive) return;
      context = document.createElement("canvas").getContext("2d");
      family = getComputedStyle(svg).fontFamily || family;
      widths.clear();
      setFontsReady(true);
    });
    onCleanup(() => {
      layout.abort();
      alive = false;
      resize.disconnect();
      svg.removeEventListener("wheel", onWheel);
      props.controls(null);
      if (frame) cancelAnimationFrame(frame);
      if (gesture?.type === "node") gesture.release?.();
    });
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
      area: note.area.index === 0 ? null : (note.area.title ?? ""),
      out: note.out.size,
      incoming: note.in.size,
      current: note.id === props.currentId,
    });
  const areaName = (note: GraphNote) => (note.area.index === 0 ? t().graphTopLevel : (note.area.title ?? ""));
  const statusNote = () => {
    const id = highlight();
    return id ? props.model.byId.get(id) : undefined;
  };
  const queryHits = createMemo(() => {
    const query = props.query.trim();
    return query ? props.notes.filter((note) => matchesQuery(note, query)).length : 0;
  });
  const hiddenHits = createMemo(() => {
    const query = props.query.trim();
    return query ? props.model.notes.filter((note) => matchesQuery(note, query)).length - queryHits() : 0;
  });
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
        role="group"
        aria-label={t().graphGroupLabel({ notebook: props.notebookName, display: props.displayName, count: props.notes.length })}
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
      >
        <g aria-hidden="true">
          <For each={hulls()}>
            {(hull) => <path class="notebook-graph__hull" data-slot={hull.area.slot} d={hull.path} stroke-width={f1(hull.pad * 2)} />}
          </For>
        </g>
        <g aria-hidden="true">
          <For each={props.edges}>
            {(edge) => {
              const d = () => {
                const a = screen().get(edge.source);
                const b = screen().get(edge.target);
                return a && b ? `M${f1(a.x)},${f1(a.y)}L${f1(b.x)},${f1(b.y)}` : "";
              };
              return (
                <path class="notebook-graph__edge" data-source={edge.source} data-target={edge.target} data-near={edgeNear(edge)} d={d()} />
              );
            }}
          </For>
        </g>
        <g aria-hidden="true">
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
          <For each={props.notes}>
            {(note) => {
              const node = () => screen().get(note.id);
              const current = note.id === props.currentId;
              return (
                <Show when={node()}>
                  {(at) => (
                    <g
                      class="notebook-graph__node"
                      data-node={note.id}
                      data-slot={note.area.slot}
                      data-orphan={note.orphan ? "" : undefined}
                      data-current={current ? "" : undefined}
                      data-near={near()?.has(note.id) ? "" : undefined}
                      data-match={matchesQuery(note, props.query) ? "" : undefined}
                      role="link"
                      tabindex={tabTarget() === note.id ? 0 : -1}
                      aria-label={nodeLabel(note)}
                      aria-current={current ? "page" : undefined}
                      transform={`translate(${f1(at().x)},${f1(at().y)})`}
                    >
                      <circle class="notebook-graph__hit" r={Math.max(at().r + 6, 12)} />
                      <Show when={current}>
                        <circle class="notebook-graph__ring" r={f1(at().r + 4)} />
                      </Show>
                      <circle class="notebook-graph__match" r={f1(at().r + 3)} />
                      <circle class="notebook-graph__disc" r={f1(at().r)} />
                      <circle class="notebook-graph__focus" r={f1(at().r + (current ? 7.5 : 4))} />
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
                >
                  {label.text}
                </text>
              </>
            )}
          </For>
        </g>
      </svg>
      <div class="notebook-graph__status" aria-hidden="true">
        <Show
          when={statusNote()}
          fallback={
            <span class="notebook-graph__status-text">
              {!positions()
                ? t().graphArranging({ count: props.notes.length })
                : props.query.trim()
                  ? queryHits()
                    ? t().graphSearchHits({ count: queryHits(), query: props.query.trim() })
                    : hiddenHits()
                      ? t().graphSearchHidden({ query: props.query.trim() })
                      : t().graphSearchNone({ query: props.query.trim() })
                  : t().graphNoteCount({ notes: props.notes.length, links: props.edges.length })}
            </span>
          }
        >
          {(note) => (
            <>
              <span class="notebook-graph__dot" data-slot={note().area.slot} />
              <strong>{note().title || t().untitled}</strong>
              <span class="notebook-graph__status-text">
                {areaName(note())} · {t().graphLinkCounts({ out: note().out.size, incoming: note().in.size })} · {t().graphChanged}{" "}
                <Format.RelativeTime value={note().updatedAt} base={props.now} />
              </span>
            </>
          )}
        </Show>
        <Show
          when={keyboard()}
          fallback={
            <>
              <span class="notebook-graph__hints" data-input="pointer">
                {t().graphPointerHints}
              </span>
              <span class="notebook-graph__hints" data-input="touch">
                {t().graphTouchHints}
              </span>
            </>
          }
        >
          <span class="notebook-graph__hints" data-input="keys">
            <Kbd keys="arrowleft" />
            <Kbd keys="arrowup" />
            <Kbd keys="arrowdown" />
            <Kbd keys="arrowright" /> {t().graphKeyMove} · <Kbd keys="enter" /> {t().graphKeyOpen} · <Kbd keys="home" />{" "}
            {t().graphKeyCurrent} · <Kbd keys="escape" /> {t().graphKeyReset}
          </span>
        </Show>
      </div>
      <Show when={selected() ? props.model.byId.get(selected()!) : undefined}>
        {(note) => (
          <div class="notebook-graph__selection" role="region" aria-label={t().graphSelected}>
            <span class="notebook-graph__dot" data-slot={note().area.slot} />
            <div class="notebook-graph__selection-text">
              <strong>{note().title || t().untitled}</strong>
              <small>
                {areaName(note())} · <i class="ti ti-arrow-up-right" aria-hidden="true" />
                <span class="sr-only">{t().graphLinksTo}</span> {note().out.size} <i class="ti ti-arrow-down-left" aria-hidden="true" />
                <span class="sr-only">{t().graphLinkedFrom}</span> {note().in.size}
              </small>
            </div>
            <Button variant="primary" size="sm" onClick={() => props.onOpen(note().id)}>
              {t().graphOpen}
            </Button>
            <IconButton label={t().graphClearSelection} size="sm" onClick={() => setSelected(null)}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </Show>
    </div>
  );
}
