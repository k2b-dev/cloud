import { navigateTo } from "@k2b/ssr/nav";
import { IconButton, IconButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { forceCenter, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { NoteGraph } from "../../../../service/links";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  notebookId: string;
  /** Optional: id of the note the user came from — gets initial focus + highlight. */
  selectedNoteId: string | null;
  graph: NoteGraph;
};

/**
 * Force-directed link graph for one notebook.
 *
 * d3-force runs the simulation; rendering is plain SolidJS SVG. Per-tick
 * position updates bypass Solid's reactivity and patch the DOM directly
 * via refs — at 60fps with 100+ nodes the granular signal approach burns
 * too much CPU.
 *
 * Interactions:
 *  - click on a node → navigate to that note
 *  - drag a node → fix its position, simulation re-settles around it
 *  - hover a node → it + its neighbours light up; the rest dims
 *  - mouse wheel on the canvas → zoom in/out (anchored on cursor)
 *  - drag the empty canvas → pan
 */

type SimNode = NoteGraph["nodes"][number] & {
  // d3-force mutates these on the input nodes.
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
};

type SimLink = {
  source: SimNode;
  target: SimNode;
};

const NODE_BASE_RADIUS = 4;
const NODE_RADIUS_PER_LINK = 1;
const NODE_MAX_RADIUS = 10;
const LINK_DISTANCE = 90;
const CHARGE_STRENGTH = -260;
const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 600;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.2;

const radiusFor = (inDegree: number): number => Math.min(NODE_MAX_RADIUS, NODE_BASE_RADIUS + inDegree * NODE_RADIUS_PER_LINK);

export default function NotebookGraph(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });

  // d3-force will mutate these arrays. Make local copies so the prop stays
  // pristine and the simulation state lives only here.
  const simNodes: SimNode[] = props.graph.nodes.map((n) => ({ ...n }));
  const nodeById = new Map<string, SimNode>(simNodes.map((n) => [n.id, n]));
  const simLinks: SimLink[] = props.graph.edges.flatMap((e) => {
    const source = nodeById.get(e.source);
    const target = nodeById.get(e.target);
    // Defensive: edges to a missing node would NaN the simulation. The
    // backend already JOINs both endpoints inside the notebook, so this
    // shouldn't fire — but filter rather than crash.
    return source && target ? [{ source, target }] : [];
  });

  // Adjacency map for hover-highlighting (built once — links don't change).
  const neighbours = new Map<string, Set<string>>();
  for (const node of simNodes) neighbours.set(node.id, new Set([node.id]));
  for (const link of simLinks) {
    neighbours.get(link.source.id)?.add(link.target.id);
    neighbours.get(link.target.id)?.add(link.source.id);
  }

  // DOM refs — we update transform/x1/y1/… imperatively per tick.
  const nodeGroups = new Map<string, SVGGElement>();
  const edgeLines = new Map<SimLink, SVGLineElement>();

  let svgRef: SVGSVGElement | undefined;
  let simulation: Simulation<SimNode, SimLink> | undefined;
  let clearPointerGesture: (() => void) | undefined;

  const closeHref = () => {
    const selected = simNodes.find((node) => node.id === props.selectedNoteId);
    return selected ? buildNoteUrl(props.notebookId, selected.id) : `/app/notebooks/${props.notebookId}`;
  };

  const setClampedZoom = (next: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));

  const openNode = (node: SimNode) => {
    node.fx = null;
    node.fy = null;
    navigateTo(buildNoteUrl(props.notebookId, node.id));
  };

  const fitGraph = () => {
    const positioned = simNodes.filter((node) => node.x !== undefined && node.y !== undefined);
    if (positioned.length === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const minX = Math.min(...positioned.map((node) => node.x! - radiusFor(node.inDegree) - 24));
    const maxX = Math.max(...positioned.map((node) => node.x! + radiusFor(node.inDegree) + 24));
    const minY = Math.min(...positioned.map((node) => node.y! - radiusFor(node.inDegree) - 24));
    const maxY = Math.max(...positioned.map((node) => node.y! + radiusFor(node.inDegree) + 32));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((VIEWBOX_WIDTH - 96) / width, (VIEWBOX_HEIGHT - 96) / height)));

    setZoom(nextZoom);
    setPan({
      x: -((minX + maxX) / 2) * nextZoom,
      y: -((minY + maxY) / 2) * nextZoom,
    });
  };

  const applyPositionsToDom = () => {
    for (const node of simNodes) {
      const el = nodeGroups.get(node.id);
      if (el && node.x !== undefined && node.y !== undefined) {
        el.setAttribute("transform", `translate(${node.x.toFixed(2)},${node.y.toFixed(2)})`);
      }
    }
    for (const link of simLinks) {
      const el = edgeLines.get(link);
      if (!el) continue;
      const sx = link.source.x;
      const sy = link.source.y;
      const tx = link.target.x;
      const ty = link.target.y;
      if (sx === undefined || sy === undefined || tx === undefined || ty === undefined) continue;
      el.setAttribute("x1", sx.toFixed(2));
      el.setAttribute("y1", sy.toFixed(2));
      el.setAttribute("x2", tx.toFixed(2));
      el.setAttribute("y2", ty.toFixed(2));
    }
  };

  // ── Pan / zoom ──────────────────────────────────────────
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom() * factor));
    // Anchor zoom on cursor position so the point under the cursor stays put.
    if (svgRef) {
      const rect = svgRef.getBoundingClientRect();
      const cx = event.clientX - rect.left - rect.width / 2;
      const cy = event.clientY - rect.top - rect.height / 2;
      const ratio = next / zoom();
      setPan((p) => ({ x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }));
    }
    setZoom(next);
  };

  // Background pan.
  const onCanvasPointerDown = (event: PointerEvent) => {
    if (event.target !== svgRef && (event.target as Element).tagName !== "rect") return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startPan = pan();
    (event.target as Element).setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      setPan({ x: startPan.x + (e.clientX - startX), y: startPan.y + (e.clientY - startY) });
    };
    clearPointerGesture?.();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      clearPointerGesture = undefined;
    };
    clearPointerGesture = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // ── Node drag ───────────────────────────────────────────
  const DRAG_THRESHOLD_PX = 4;

  const onNodePointerDown = (node: SimNode, event: PointerEvent) => {
    event.stopPropagation();
    if (!simulation) return;

    // Snapshot the node's position at click time. `fx`/`fy` track *absolute*
    // coords from this origin — using `node.x` (which the simulation rewrites
    // every tick) compounds drift across pointermove events.
    const origX = node.x ?? 0;
    const origY = node.y ?? 0;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let didMove = false;

    simulation.alphaTarget(0.3).restart();
    node.fx = origX;
    node.fy = origY;

    (event.currentTarget as Element).setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const dx = (e.clientX - startClientX) / zoom();
      const dy = (e.clientY - startClientY) / zoom();
      // Dead zone: ignore sub-threshold movement so hand jitter on a click
      // doesn't get classified as a drag (which would suppress the
      // click-to-navigate on pointer-up).
      if (!didMove && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      didMove = true;
      node.fx = origX + dx;
      node.fy = origY + dy;
    };

    clearPointerGesture?.();
    const finish = (navigate: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      clearPointerGesture = undefined;
      simulation?.alphaTarget(0);
      if (navigate && !didMove) {
        openNode(node);
      }
      // If the user dragged, keep `fx`/`fy` so the node stays where they
      // dropped it. The simulation will re-settle the rest around it.
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    clearPointerGesture = cancel;

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // ── Hover dimming ───────────────────────────────────────
  const isDimmed = (id: string): boolean => {
    const hover = hoveredId();
    if (!hover) return false;
    return !neighbours.get(hover)?.has(id);
  };

  const isLinkDimmed = (link: SimLink): boolean => {
    const hover = hoveredId();
    if (!hover) return false;
    return link.source.id !== hover && link.target.id !== hover;
  };

  const isSelected = (id: string): boolean => id === props.selectedNoteId;

  // ── Lifecycle ───────────────────────────────────────────
  onMount(() => {
    if (simNodes.length === 0) return;

    // Seed the selected note at the centre so it doesn't whip across the
    // canvas while the simulation cools.
    if (props.selectedNoteId) {
      const seed = simNodes.find((n) => n.id === props.selectedNoteId);
      if (seed) {
        seed.x = 0;
        seed.y = 0;
      }
    }

    simulation = forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(LINK_DISTANCE),
      )
      .force("charge", forceManyBody().strength(CHARGE_STRENGTH))
      .force("center", forceCenter(0, 0))
      .on("tick", applyPositionsToDom);
  });

  onCleanup(() => {
    clearPointerGesture?.();
    simulation?.stop();
  });

  return (
    <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
      <Show when={simNodes.length > 0} fallback={<EmptyState />}>
        <Tooltip.Anchor content={t().closeGraph}>
          <IconButtonLink href={closeHref()} size="sm" class="absolute left-2 top-2 z-10" label={t().closeGraph}>
            <i class="ti ti-x" />
          </IconButtonLink>
        </Tooltip.Anchor>

        <svg
          ref={svgRef}
          class="w-full h-full select-none touch-none cursor-grab active:cursor-grabbing"
          viewBox="-400 -300 800 600"
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onCanvasPointerDown}
        >
          {/* invisible rect captures background drags reliably */}
          <rect x="-100000" y="-100000" width="200000" height="200000" fill="transparent" />

          <g transform={`translate(${pan().x},${pan().y}) scale(${zoom()})`}>
            {/* Edges — same fill color as nodes, slightly thinner stroke. */}
            <For each={simLinks}>
              {(link) => (
                <line
                  ref={(el) => edgeLines.set(link, el)}
                  class={`stroke-zinc-400 dark:stroke-zinc-600 transition-opacity ${isLinkDimmed(link) ? "opacity-15" : "opacity-70"}`}
                  stroke-width="1"
                />
              )}
            </For>

            {/* Nodes — borderless circles in the same neutral as the edges;
                the selected note uses the shared accent palette. */}
            <For each={simNodes}>
              {(node) => {
                const radius = radiusFor(node.inDegree);
                return (
                  <g
                    ref={(el) => nodeGroups.set(node.id, el)}
                    class={`cursor-pointer transition-opacity ${isDimmed(node.id) ? "opacity-25" : "opacity-100"}`}
                    role="link"
                    tabIndex={0}
                    aria-label={t().openNote({ title: node.title || t().untitled })}
                    onPointerDown={(e) => onNodePointerDown(node, e)}
                    onPointerEnter={() => setHoveredId(node.id)}
                    onPointerLeave={() => setHoveredId(null)}
                    onFocus={() => setFocusedId(node.id)}
                    onBlur={() => setFocusedId(null)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openNode(node);
                    }}
                  >
                    <circle
                      r={radius}
                      class={`${isSelected(node.id) ? "fill-blue-200 dark:fill-blue-900" : "fill-zinc-400 dark:fill-zinc-600"} ${
                        focusedId() === node.id ? "stroke-blue-500 stroke-2" : ""
                      }`}
                    />
                    <text
                      y={radius + 12}
                      text-anchor="middle"
                      class={`text-[11px] pointer-events-none ${
                        isSelected(node.id) ? "fill-blue-700 dark:fill-blue-300 font-medium" : "fill-zinc-600 dark:fill-zinc-400"
                      } ${hoveredId() === node.id ? "underline underline-offset-2" : ""}`}
                    >
                      {node.title || t().untitled}
                    </text>
                  </g>
                );
              }}
            </For>
          </g>
        </svg>

        <div class="absolute bottom-2 right-2 z-10 flex flex-col gap-1 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-1 shadow-[var(--ui-shadow-float)]">
          <Tooltip.Anchor content={t().zoomIn}>
            <IconButton label={t().zoomIn} size="sm" onClick={() => setClampedZoom(zoom() * ZOOM_STEP)}>
              <i class="ti ti-plus" />
            </IconButton>
          </Tooltip.Anchor>
          <Tooltip.Anchor content={t().zoomOut}>
            <IconButton label={t().zoomOut} size="sm" onClick={() => setClampedZoom(zoom() / ZOOM_STEP)}>
              <i class="ti ti-minus" />
            </IconButton>
          </Tooltip.Anchor>
          <Tooltip.Anchor content={t().fitGraph}>
            <IconButton label={t().fitGraph} size="sm" onClick={fitGraph}>
              <i class="ti ti-focus-centered" />
            </IconButton>
          </Tooltip.Anchor>
        </div>
      </Show>
    </div>
  );
}

const EmptyState = () => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="text-center text-xs text-dimmed flex flex-col items-center gap-2 max-w-sm">
        <i class="ti ti-affiliate text-2xl" />
        <p class="font-medium">{t().noGraph}</p>
        <p>{t().noGraphDescription}</p>
      </div>
    </div>
  );
};
