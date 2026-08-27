import { type DndCollisionContext, type DndController, type DndDroppableSnapshot, dnd } from "@k2b/stdlib/solid";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import {
  activatePanesItem,
  applyPanesIntent,
  getPanesDropTargets,
  PANES_MAX_ID_LENGTH,
  PANES_MIN_RATIO,
  type PanesDropTarget,
  type PanesGroup,
  type PanesIntent,
  type PanesLayout,
  type PanesNode,
  type PanesPath,
  type PanesSplit,
  parsePanesLayout,
  resizePanesSplit,
  samePanesIntent,
} from "./panes-layout";
import { assertUniqueStableUiIds } from "./stable-id";

export type PanesItem = {
  id: string;
  title: string;
  icon?: string;
  render: () => JSX.Element;
  onClose?: () => void;
};

export type PanesProps = {
  layout: PanesLayout;
  onLayoutChange: (layout: PanesLayout) => void;
  items: readonly PanesItem[];
  movable?: boolean;
  resizable?: boolean;
  split?: false | "horizontal" | "vertical" | "both";
  onAddItem?: (targetItemId: string | null) => void;
  ariaLabel?: string;
  class?: string;
};

type DragMeta = { itemId: string; label: string };
type DropMeta = { target: PanesDropTarget; label: string };
type PaneDnd = DndController<DragMeta, DropMeta, PanesIntent>;

type IndexedPanesDropTargets = {
  tabs: ReadonlyMap<string | null, PanesDropTarget>;
  body: readonly PanesDropTarget[];
};

type PanesSeparatorGeometry = {
  coordinate: number;
  crossStart: number;
  crossEnd: number;
};

const PANES_RESIZE_SNAP_DISTANCE = 8;
const PANES_RESIZE_UNSNAP_DISTANCE = 12;
const PANES_RESIZE_NEIGHBOR_GAP = 16;

const intervalGap = (left: PanesSeparatorGeometry, right: PanesSeparatorGeometry): number =>
  left.crossEnd < right.crossStart
    ? right.crossStart - left.crossEnd
    : right.crossEnd < left.crossStart
      ? left.crossStart - right.crossEnd
      : 0;

export const resolvePanesResizeSnap = (
  coordinate: number,
  source: PanesSeparatorGeometry,
  candidates: readonly PanesSeparatorGeometry[],
  options: { activeCoordinate?: number | null; previousCoordinate?: number } = {},
): { coordinate: number; snappedTo: number | null } => {
  const neighbors = candidates.filter((candidate) => {
    const gap = intervalGap(source, candidate);
    return gap > 0 && gap <= PANES_RESIZE_NEIGHBOR_GAP;
  });
  const activeCoordinate = options.activeCoordinate;
  const active =
    activeCoordinate === null || activeCoordinate === undefined
      ? null
      : neighbors.find((candidate) => Math.abs(candidate.coordinate - activeCoordinate) < 0.5);
  if (active && Math.abs(coordinate - active.coordinate) <= PANES_RESIZE_UNSNAP_DISTANCE) {
    return { coordinate: active.coordinate, snappedTo: active.coordinate };
  }

  const previous = options.previousCoordinate;
  let winner: PanesSeparatorGeometry | null = null;
  let winnerDistance = Number.POSITIVE_INFINITY;
  for (const candidate of neighbors) {
    if (previous !== undefined && Math.abs(candidate.coordinate - previous) < 0.5) continue;
    const distanceToRange =
      previous === undefined ||
      candidate.coordinate < Math.min(previous, coordinate) ||
      candidate.coordinate > Math.max(previous, coordinate)
        ? Math.abs(candidate.coordinate - coordinate)
        : 0;
    const distanceToCoordinate = Math.abs(candidate.coordinate - coordinate);
    if (distanceToRange <= PANES_RESIZE_SNAP_DISTANCE && distanceToCoordinate < winnerDistance) {
      winner = candidate;
      winnerDistance = distanceToCoordinate;
    }
  }
  return winner ? { coordinate: winner.coordinate, snappedTo: winner.coordinate } : { coordinate, snappedTo: null };
};

export const indexPanesDropTargets = (targets: readonly PanesDropTarget[]): ReadonlyMap<string, IndexedPanesDropTargets> => {
  const mutable = new Map<string, { tabs: Map<string | null, PanesDropTarget>; body: PanesDropTarget[] }>();
  for (const target of targets) {
    let indexed = mutable.get(target.targetItemId);
    if (!indexed) {
      indexed = { tabs: new Map(), body: [] };
      mutable.set(target.targetItemId, indexed);
    }
    if (target.kind === "tab") indexed.tabs.set(target.beforeItemId ?? null, target);
    else indexed.body.push(target);
  }
  return mutable;
};

const iconClass = (icon: string | undefined): string => {
  const value = icon?.trim() || "ti-layout-sidebar-right";
  return value.startsWith("ti ") ? value : `ti ${value}`;
};

const collectLayoutItemIds = (node: PanesNode | null, ids: string[] = []): string[] => {
  if (!node) return ids;
  if (node.type === "group") ids.push(...node.items);
  else {
    collectLayoutItemIds(node.first, ids);
    collectLayoutItemIds(node.second, ids);
  }
  return ids;
};

const nearestDroppable = (entries: DndDroppableSnapshot<DropMeta>[]): DndDroppableSnapshot<DropMeta> | null =>
  entries.reduce<DndDroppableSnapshot<DropMeta> | null>(
    (winner, entry) => (!winner || entry.distance < winner.distance ? entry : winner),
    null,
  );

export const pointerHitsPanesDropTarget = (
  entry: Pick<DndDroppableSnapshot<DropMeta>, "containsPointer" | "meta" | "rect"> &
    Partial<Pick<DndDroppableSnapshot<DropMeta>, "element">>,
  pointer: { x: number; y: number },
  hitElement?: Element | null,
): boolean => {
  if (hitElement !== undefined && !entry.element?.contains(hitElement)) return false;
  const side = entry.meta.target.side;
  if (entry.meta.target.kind !== "split" || !side) return entry.containsPointer;
  if (!entry.containsPointer) return false;
  const x = pointer.x - entry.rect.left;
  const y = pointer.y - entry.rect.top;
  if (side === "top") return x >= y && x <= entry.rect.width - y;
  if (side === "bottom") {
    const corner = entry.rect.height - y;
    return x >= corner && x <= entry.rect.width - corner;
  }
  if (side === "left") return y >= x && y <= entry.rect.height - x;
  const corner = entry.rect.width - x;
  return y >= corner && y <= entry.rect.height - corner;
};

const panesCollisionDetector = (
  context: DndCollisionContext<DragMeta, DropMeta, PanesIntent>,
  mode: "pointer" | "keyboard" | null,
): string | null => {
  const document = mode === "pointer" ? context.droppables[0]?.element.ownerDocument : undefined;
  const hitElement = document?.elementFromPoint(context.pointer.x, context.pointer.y) ?? undefined;
  return nearestDroppable(context.droppables.filter((entry) => pointerHitsPanesDropTarget(entry, context.pointer, hitElement)))?.id ?? null;
};

const createItemMap = (items: readonly PanesItem[]): Map<string, PanesItem> => {
  assertUniqueStableUiIds(
    items.map((item) => item.id),
    "Panes item id",
    PANES_MAX_ID_LENGTH,
  );
  return new Map(items.map((item) => [item.id, item]));
};

const requireItem = (items: Map<string, PanesItem>, id: string): PanesItem => {
  const item = items.get(id);
  if (!item) throw new Error(`Panes layout references missing item "${id}".`);
  return item;
};

export default function Panes(props: PanesProps): JSX.Element {
  const messages = useUiMessages();
  const instanceId = `k2b-panes-${createUniqueId()}`;
  const items = createMemo(() => createItemMap(props.items));
  const layout = createMemo(() => {
    if (!parsePanesLayout(props.layout)) throw new Error("Panes layout must be a valid version 2 layout.");
    for (const id of collectLayoutItemIds(props.layout.root)) requireItem(items(), id);
    return props.layout;
  });
  const canMove = () => props.movable ?? true;
  const canResize = () => props.resizable ?? true;
  const split = () => props.split ?? "both";
  const [draggedItemId, setDraggedItemId] = createSignal<string | null>(null);
  const [dragMode, setDragMode] = createSignal<"pointer" | "keyboard" | null>(null);
  const dropTargets = createMemo(() => {
    const itemId = draggedItemId();
    return itemId ? getPanesDropTargets(layout(), itemId, { movable: canMove(), split: split() }) : [];
  });
  const dropTargetIndex = createMemo(() => indexPanesDropTargets(dropTargets()));
  const paneDnd = dnd.create<DragMeta, DropMeta, PanesIntent>({
    collisionDetector: (context) => panesCollisionDetector(context, dragMode()),
    buildIntent: ({ over }) => over?.meta.target.intent ?? null,
    isSameIntent: samePanesIntent,
    onDragStart: ({ active, mode }) => {
      setDragMode(mode);
      setDraggedItemId(active.meta.itemId);
    },
    announcements: {
      dragStart: (active) => `Picked up ${active.meta.label}.`,
      dragOver: (active, over) => (over ? `Move ${active.meta.label} to ${over.meta.label}.` : `${active.meta.label} is not over a pane.`),
      drop: (active, over) => (over ? `Moved ${active.meta.label} to ${over.meta.label}.` : `Did not move ${active.meta.label}.`),
      cancel: (active) => `Cancelled moving ${active.meta.label}.`,
    },
    onDrop: ({ intent, mode }) => {
      setDragMode(null);
      setDraggedItemId(null);
      if (!intent) return;
      const current = layout();
      const next = applyPanesIntent(current, intent);
      if (next === current) return;
      props.onLayoutChange(next);
      if (mode === "keyboard") queueMicrotask(() => document.getElementById(`${instanceId}-${intent.itemId}-tab`)?.focus());
    },
    onCancel: () => {
      setDragMode(null);
      setDraggedItemId(null);
    },
  });
  const activate = (itemId: string) => {
    const current = layout();
    const next = activatePanesItem(current, itemId);
    if (next !== current) props.onLayoutChange(next);
  };
  const requestAdd = (targetItemId: string | null) => props.onAddItem?.(targetItemId);

  return (
    <div class={`k2b-panes ${props.class ?? ""}`} data-k2b-panes role="group" aria-label={props.ariaLabel ?? messages().paneWorkspace}>
      <Show
        when={layout().root}
        fallback={
          <div class="k2b-panes__empty">
            <Show when={props.onAddItem !== undefined}>
              <button type="button" class="k2b-panes__add" onClick={() => requestAdd(null)} aria-label={messages().addPane}>
                <i class="ti ti-plus" aria-hidden="true" />
                <span>{messages().addPane}</span>
              </button>
            </Show>
          </div>
        }
      >
        {(root) => (
          <PanesNodeRenderer
            node={root}
            path={[]}
            layout={layout}
            itemById={items}
            dnd={paneDnd}
            dropTargetIndex={dropTargetIndex}
            instanceId={instanceId}
            canMove={canMove}
            canResize={canResize}
            addItem={requestAdd}
            canAdd={() => props.onAddItem !== undefined}
            onActivate={activate}
            onLayoutChange={props.onLayoutChange}
          />
        )}
      </Show>
    </div>
  );
}

type RendererProps = {
  node: () => PanesNode;
  path: PanesPath;
  layout: () => PanesLayout;
  itemById: () => Map<string, PanesItem>;
  dnd: PaneDnd;
  dropTargetIndex: () => ReadonlyMap<string, IndexedPanesDropTargets>;
  instanceId: string;
  canMove: () => boolean;
  canResize: () => boolean;
  addItem: (targetItemId: string | null) => void;
  canAdd: () => boolean;
  onActivate: (itemId: string) => void;
  onLayoutChange: (layout: PanesLayout) => void;
};

function PanesNodeRenderer(props: RendererProps): JSX.Element {
  const split = createMemo(() => {
    const node = props.node();
    return node.type === "split" ? node : null;
  });
  const group = createMemo(() => {
    const node = props.node();
    return node.type === "group" ? node : null;
  });
  return (
    <>
      <Show when={split()}>{(node) => <PanesSplitRenderer {...props} node={node} />}</Show>
      <Show when={group()}>{(node) => <PanesGroupRenderer {...props} node={node} />}</Show>
    </>
  );
}

function PanesSplitRenderer(props: Omit<RendererProps, "node"> & { node: () => PanesSplit }): JSX.Element {
  const messages = useUiMessages();
  let container: HTMLDivElement | undefined;
  let separatorElement: HTMLButtonElement | undefined;
  let stopResize: (() => void) | undefined;
  let finishResize: (() => void) | undefined;
  const stopActiveResize = () => {
    stopResize?.();
    stopResize = undefined;
    finishResize = undefined;
  };
  const finishActiveResize = () => {
    finishResize?.();
    stopResize = undefined;
    finishResize = undefined;
  };
  onCleanup(stopActiveResize);
  const commitRatio = (ratio: number) => {
    const current = props.layout();
    const next = resizePanesSplit(current, props.path, ratio);
    if (next !== current) props.onLayoutChange(next);
  };
  const resizeGeometry = (separator: HTMLElement | undefined) => {
    if (!separator) return null;
    const direction = props.node().direction;
    const containerRect = container?.getBoundingClientRect();
    const separatorRect = separator.getBoundingClientRect();
    const extent = direction === "horizontal" ? (containerRect?.width ?? 0) : (containerRect?.height ?? 0);
    const separatorExtent = direction === "horizontal" ? separatorRect.width : separatorRect.height;
    const availableExtent = extent - separatorExtent;
    if (!containerRect || availableExtent <= 0 || separatorRect.width <= 0 || separatorRect.height <= 0) return null;
    const geometry = (rect: DOMRect): PanesSeparatorGeometry =>
      direction === "horizontal"
        ? { coordinate: rect.left + rect.width / 2, crossStart: rect.top, crossEnd: rect.bottom }
        : { coordinate: rect.top + rect.height / 2, crossStart: rect.left, crossEnd: rect.right };
    const panes = separator.closest<HTMLElement>("[data-k2b-panes]");
    const candidates = panes
      ? Array.from(panes.querySelectorAll<HTMLElement>(`.k2b-panes__separator[data-direction="${direction}"]`))
          .filter((candidate) => candidate !== separator && candidate.closest("[data-k2b-panes]") === panes)
          .map((candidate) => candidate.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map(geometry)
      : [];
    const origin = direction === "horizontal" ? containerRect.left + separatorExtent / 2 : containerRect.top + separatorExtent / 2;
    return {
      source: geometry(separatorRect),
      candidates,
      coordinateForRatio: (ratio: number) => origin + availableExtent * ratio,
      ratioForCoordinate: (coordinate: number) => (coordinate - origin) / availableExtent,
    };
  };
  const startResize = (event: PointerEvent) => {
    if (!props.canResize()) return;
    event.preventDefault();
    stopActiveResize();
    const pointerId = event.pointerId;
    const captureTarget = (event.currentTarget as HTMLElement | null) ?? separatorElement;
    if (!captureTarget) return;
    const start = props.node().direction === "horizontal" ? event.clientX : event.clientY;
    const geometry = resizeGeometry(captureTarget);
    const startRatio = props.node().ratio;
    const startCoordinate = geometry?.source.coordinate;
    const rect = container?.getBoundingClientRect();
    const extent = Math.max(1, props.node().direction === "horizontal" ? (rect?.width ?? 1) : (rect?.height ?? 1));
    let snappedTo: number | null = null;
    let frame: number | undefined;
    let pendingRatio: number | undefined;
    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (pendingRatio === undefined) return;
      const ratio = pendingRatio;
      pendingRatio = undefined;
      commitRatio(ratio);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const current = props.node().direction === "horizontal" ? move.clientX : move.clientY;
      if (geometry && startCoordinate !== undefined) {
        const snapped = resolvePanesResizeSnap(startCoordinate + current - start, geometry.source, geometry.candidates, {
          activeCoordinate: snappedTo,
        });
        snappedTo = snapped.snappedTo;
        pendingRatio = geometry.ratioForCoordinate(snapped.coordinate);
      } else {
        pendingRatio = startRatio + (current - start) / extent;
      }
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId === pointerId) finishActiveResize();
    };
    stopResize = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pendingRatio = undefined;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", finishActiveResize);
      if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
    };
    finishResize = () => {
      flush();
      stopResize?.();
    };
    captureTarget.setPointerCapture?.(pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", finishActiveResize);
  };
  const onResizeKeyDown = (event: KeyboardEvent) => {
    if (!props.canResize()) return;
    const step = event.shiftKey ? 0.08 : 0.02;
    let ratio: number | null = null;
    if (event.key === "Home") ratio = PANES_MIN_RATIO;
    if (event.key === "End") ratio = 1 - PANES_MIN_RATIO;
    if (props.node().direction === "horizontal" && event.key === "ArrowLeft") ratio = props.node().ratio - step;
    if (props.node().direction === "horizontal" && event.key === "ArrowRight") ratio = props.node().ratio + step;
    if (props.node().direction === "vertical" && event.key === "ArrowUp") ratio = props.node().ratio - step;
    if (props.node().direction === "vertical" && event.key === "ArrowDown") ratio = props.node().ratio + step;
    if (ratio === null) return;
    event.preventDefault();
    const geometry = resizeGeometry((event.currentTarget as HTMLElement | null) ?? separatorElement);
    if (geometry) {
      const snapped = resolvePanesResizeSnap(geometry.coordinateForRatio(ratio), geometry.source, geometry.candidates, {
        previousCoordinate: geometry.source.coordinate,
      });
      ratio = geometry.ratioForCoordinate(snapped.coordinate);
    }
    commitRatio(ratio);
  };
  return (
    <div ref={container} class="k2b-panes__split" data-direction={props.node().direction}>
      <div class="k2b-panes__split-child" style={{ flex: `${props.node().ratio} 1 0` }}>
        <PanesNodeRenderer {...props} node={() => props.node().first} path={[...props.path, "first"]} />
      </div>
      <button
        ref={separatorElement}
        type="button"
        role="separator"
        aria-orientation={props.node().direction === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(PANES_MIN_RATIO * 100)}
        aria-valuemax={Math.round((1 - PANES_MIN_RATIO) * 100)}
        aria-valuenow={Math.round(props.node().ratio * 100)}
        aria-disabled={!props.canResize()}
        tabIndex={props.canResize() ? 0 : -1}
        class="k2b-panes__separator"
        data-direction={props.node().direction}
        aria-label={messages().resizePanes}
        onPointerDown={startResize}
        onKeyDown={onResizeKeyDown}
      >
        <span aria-hidden="true" />
      </button>
      <div class="k2b-panes__split-child" style={{ flex: `${1 - props.node().ratio} 1 0` }}>
        <PanesNodeRenderer {...props} node={() => props.node().second} path={[...props.path, "second"]} />
      </div>
    </div>
  );
}

function ActivePane(props: { itemId: string; itemById: () => Map<string, PanesItem> }): JSX.Element {
  return requireItem(props.itemById(), props.itemId).render();
}

function PanesGroupRenderer(props: Omit<RendererProps, "node"> & { node: () => PanesGroup }): JSX.Element {
  const messages = useUiMessages();
  let tabsElement: HTMLDivElement | undefined;
  let scrollbarDragOffset = 0;
  let stopTabPress: (() => void) | undefined;
  let suppressedPointerClick: string | null = null;
  let clearSuppressedPointerClick: number | undefined;
  const dndInstanceId = createUniqueId();
  const draggableId = (id: string) => `panes-item:${dndInstanceId}:${id}`;
  const itemIds = createMemo(() => props.node().items);
  const groupTargets = createMemo<IndexedPanesDropTargets | null>(() => {
    const index = props.dropTargetIndex();
    for (const itemId of itemIds()) {
      const indexed = index.get(itemId);
      if (indexed) return indexed;
    }
    return null;
  });
  const targetBefore = (itemId: string) => groupTargets()?.tabs.get(itemId);
  const targetAtEnd = () => groupTargets()?.tabs.get(null);
  const bodyTargets = () => groupTargets()?.body ?? [];
  const startTabPress = (event: PointerEvent & { currentTarget: HTMLButtonElement }, itemId: string) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    stopTabPress?.();
    const pointerId = event.pointerId;
    const button = event.currentTarget;
    const ownerWindow = window;
    const stop = () => {
      ownerWindow.removeEventListener("pointerup", onPointerUp, true);
      ownerWindow.removeEventListener("pointercancel", onPointerCancel, true);
      if (stopTabPress === stop) stopTabPress = undefined;
    };
    const onPointerUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const rect = button.getBoundingClientRect();
      const releasedInside = up.clientX >= rect.left && up.clientX <= rect.right && up.clientY >= rect.top && up.clientY <= rect.bottom;
      const shouldActivate = releasedInside && !props.dnd.isDragging();
      stop();
      if (!shouldActivate) return;
      suppressedPointerClick = itemId;
      if (clearSuppressedPointerClick !== undefined) ownerWindow.clearTimeout(clearSuppressedPointerClick);
      clearSuppressedPointerClick = ownerWindow.setTimeout(() => {
        if (suppressedPointerClick === itemId) suppressedPointerClick = null;
        clearSuppressedPointerClick = undefined;
      }, 0);
      props.onActivate(itemId);
    };
    const onPointerCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) stop();
    };
    stopTabPress = stop;
    ownerWindow.addEventListener("pointerup", onPointerUp, true);
    ownerWindow.addEventListener("pointercancel", onPointerCancel, true);
  };
  onCleanup(() => {
    stopTabPress?.();
    if (clearSuppressedPointerClick !== undefined) window.clearTimeout(clearSuppressedPointerClick);
  });
  const [scrollbar, setScrollbar] = createSignal({ overflow: false, left: 0, width: 0 });
  const syncScrollbar = () => {
    if (!tabsElement) return;
    const { clientWidth, scrollLeft, scrollWidth } = tabsElement;
    if (scrollWidth <= clientWidth || clientWidth <= 0) {
      setScrollbar({ overflow: false, left: 0, width: 0 });
      return;
    }
    const width = Math.min(clientWidth, Math.max(24, (clientWidth * clientWidth) / scrollWidth));
    const left = (scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - width);
    setScrollbar({ overflow: true, left, width });
  };
  const scrollFromPointer = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!tabsElement) return;
    const track = event.currentTarget;
    const { left, width } = scrollbar();
    const rect = track.getBoundingClientRect();
    const available = Math.max(1, rect.width - width);
    const thumbLeft = Math.min(available, Math.max(0, event.clientX - rect.left - scrollbarDragOffset));
    tabsElement.scrollLeft = (thumbLeft / available) * (tabsElement.scrollWidth - tabsElement.clientWidth);
    syncScrollbar();
  };
  const startScrollbarDrag = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    event.preventDefault();
    const track = event.currentTarget;
    const current = scrollbar();
    scrollbarDragOffset =
      event.target === track
        ? current.width / 2
        : Math.min(current.width, Math.max(0, event.clientX - track.getBoundingClientRect().left - current.left));
    track.setPointerCapture(event.pointerId);
    scrollFromPointer(event);
  };
  onMount(() => {
    syncScrollbar();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncScrollbar);
    if (tabsElement) observer?.observe(tabsElement);
    onCleanup(() => observer?.disconnect());
  });
  createEffect(() => {
    itemIds().length;
    props.itemById();
    groupTargets();
    props.canAdd();
    queueMicrotask(syncScrollbar);
  });
  const tabId = (itemId: string) => `${props.instanceId}-${itemId}-tab`;
  const panelId = (itemId: string) => `${props.instanceId}-${itemId}-panel`;
  const focusTab = (index: number) => {
    const itemId = itemIds()[index];
    if (!itemId) return;
    props.onActivate(itemId);
    queueMicrotask(() => document.getElementById(tabId(itemId))?.focus());
  };
  const onTabKeyDown = (event: KeyboardEvent, index: number, itemId: string) => {
    if (props.dnd.activeId() === draggableId(itemId)) return;
    const item = requireItem(props.itemById(), itemId);
    if ((event.key === "Delete" || event.key === "Backspace") && item.onClose) {
      event.preventDefault();
      item.onClose();
      return;
    }
    const count = itemIds().length;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    focusTab(next);
  };
  const targetLabel = (target: PanesDropTarget): string => {
    const targetItem = requireItem(props.itemById(), target.targetItemId);
    if (target.kind === "group") return messages().addToNamed({ name: targetItem.title });
    if (target.kind === "tab") {
      const before = target.beforeItemId ? requireItem(props.itemById(), target.beforeItemId) : null;
      return before ? messages().insertBeforeNamed({ name: before.title }) : messages().insertAtEnd;
    }
    return target.side
      ? messages().addPaneSide({ side: target.side, name: targetItem.title })
      : messages().addToNamed({ name: targetItem.title });
  };
  return (
    <section class="k2b-panes__group">
      <div
        ref={tabsElement}
        class="k2b-panes__tabs"
        role="tablist"
        aria-label={messages().paneTabs}
        aria-orientation="horizontal"
        onScroll={syncScrollbar}
      >
        <For each={itemIds()}>
          {(itemId, index) => {
            const item = () => requireItem(props.itemById(), itemId);
            const active = () => props.node().active === itemId;
            return (
              <div
                ref={(surface) =>
                  props.dnd.draggable(surface, () => ({
                    id: draggableId(itemId),
                    meta: { itemId, label: item().title },
                    disabled: !props.canMove(),
                    focusable: false,
                    keyboard: true,
                    handleSelector: ".k2b-panes__tab-button",
                  }))
                }
                class="k2b-panes__tab"
                data-active={active() ? "true" : undefined}
                data-closable={item().onClose !== undefined ? "true" : undefined}
                data-movable={props.canMove() ? "true" : undefined}
                data-dnd-active={props.dnd.activeId() === draggableId(itemId) ? "true" : undefined}
              >
                <Show when={targetBefore(itemId)}>
                  {(target) => <PanesDropTargetView target={target()} label={targetLabel(target())} dnd={props.dnd} placement="tab" />}
                </Show>
                <button
                  id={tabId(itemId)}
                  type="button"
                  class="k2b-panes__tab-button"
                  role="tab"
                  aria-label={item().title}
                  aria-selected={active()}
                  aria-controls={active() ? panelId(itemId) : undefined}
                  aria-posinset={index() + 1}
                  aria-setsize={itemIds().length}
                  aria-keyshortcuts={item().onClose ? "Delete Backspace" : undefined}
                  tabIndex={active() ? 0 : -1}
                  title={item().title}
                  onPointerDown={(event) => startTabPress(event, itemId)}
                  onClick={(event) => {
                    if (event?.detail > 0 && suppressedPointerClick === itemId) {
                      suppressedPointerClick = null;
                      if (clearSuppressedPointerClick !== undefined) {
                        window.clearTimeout(clearSuppressedPointerClick);
                        clearSuppressedPointerClick = undefined;
                      }
                      return;
                    }
                    props.onActivate(itemId);
                  }}
                  onKeyDown={(event) => onTabKeyDown(event, index(), itemId)}
                >
                  <span class="k2b-ui k2b-panes__drag-surface k2b-panes__drag-preview" data-dnd-preview>
                    <i class={`${iconClass(item().icon)} k2b-panes__icon`} aria-hidden="true" />
                    <span>{item().title}</span>
                  </span>
                </button>
                <Show when={item().onClose !== undefined}>
                  <button
                    type="button"
                    class="k2b-panes__close"
                    title={messages().closeNamed({ name: item().title })}
                    aria-label={messages().closeNamed({ name: item().title })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      item().onClose?.();
                    }}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={targetAtEnd()}>
          {(target) => <PanesDropTargetView target={target()} label={targetLabel(target())} dnd={props.dnd} placement="tab-end" />}
        </Show>
        <Show when={props.canAdd()}>
          <button
            type="button"
            class="k2b-panes__add k2b-panes__add--tab"
            aria-label={messages().addPane}
            title={messages().addPane}
            onClick={() => props.addItem(props.node().active)}
          >
            <i class="ti ti-plus" aria-hidden="true" />
          </button>
        </Show>
      </div>
      <Show when={scrollbar().overflow}>
        <div
          class="k2b-panes__tabs-scrollbar"
          aria-hidden="true"
          onPointerDown={startScrollbarDrag}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollFromPointer(event);
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          <span
            style={{
              "--k2b-panes-scroll-left": `${scrollbar().left}px`,
              "--k2b-panes-scroll-width": `${scrollbar().width}px`,
            }}
          />
        </div>
      </Show>
      <div class="k2b-panes__body">
        <div id={panelId(props.node().active)} class="k2b-panes__panel" role="tabpanel" aria-labelledby={tabId(props.node().active)}>
          <Show when={props.node().active} keyed>
            {(itemId) => <ActivePane itemId={itemId} itemById={props.itemById} />}
          </Show>
        </div>
      </div>
      <Show when={bodyTargets().length > 0}>
        <div class="k2b-panes__drop-targets" aria-hidden="true">
          <For each={bodyTargets()}>
            {(target) => <PanesDropTargetView target={target} label={targetLabel(target)} dnd={props.dnd} placement="body" />}
          </For>
        </div>
      </Show>
    </section>
  );
}

function PanesDropTargetView(props: {
  target: PanesDropTarget;
  label: string;
  dnd: PaneDnd;
  placement: "tab" | "tab-end" | "body";
}): JSX.Element {
  const icon = () => {
    if (props.target.kind === "group") return "ti ti-plus";
    if (props.target.kind === "tab") return props.placement === "tab" ? "ti ti-spacing-horizontal" : null;
    if (props.target.side === "top") return "ti ti-row-insert-top";
    if (props.target.side === "bottom") return "ti ti-row-insert-bottom";
    if (props.target.side === "left") return "ti ti-column-insert-left";
    return "ti ti-column-insert-right";
  };
  return (
    <div
      ref={(element) =>
        props.dnd.droppable(element, () => ({
          id: `panes-target:${props.target.id}`,
          meta: { target: props.target, label: props.label },
        }))
      }
      class="k2b-panes__drop-target"
      data-kind={props.target.kind}
      data-placement={props.placement}
      data-zone={props.target.side}
      data-active={props.dnd.overId() === `panes-target:${props.target.id}` ? "true" : undefined}
      title={props.label}
      aria-hidden="true"
    >
      <Show when={icon()} keyed>
        {(iconClass) => <i class={iconClass} aria-hidden="true" />}
      </Show>
      <Show when={props.target.kind === "split"}>
        <span>{props.label}</span>
      </Show>
    </div>
  );
}
