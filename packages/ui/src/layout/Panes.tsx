import { type DndCollisionContext, type DndController, type DndDroppableSnapshot, dnd } from "@k2b/stdlib/solid";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dropdown, type DropdownAnchor, type DropdownItem, type DropdownReturnFocus } from "../actions/Dropdown";
import { announce } from "../feedback/announce";
import { MovedHint } from "../feedback/MovedHint";
import { Tooltip } from "../feedback/Tooltip";
import { suppressTextSelection } from "../internal/text-selection";
import { useUiMessages } from "../intl/messages";
import {
  activatePanesItem,
  applyPanesIntent,
  applyPanesPreset,
  canApplyPanesPreset,
  getPanesDropTargets,
  getPanesMoves,
  getPanesPreset,
  getPanesSplitRatio,
  PANES_MAX_ID_LENGTH,
  PANES_MIN_RATIO,
  PANES_PRESETS,
  type PanesDropTarget,
  type PanesGroup,
  type PanesIntent,
  type PanesLayout,
  type PanesMove,
  type PanesNode,
  type PanesPath,
  type PanesPreset,
  type PanesSplit,
  panesItemOrder,
  parsePanesLayout,
  projectPanesLayout,
  resizePanesSplit,
  samePanesArrangement,
  samePanesIntent,
  samePanesSizes,
} from "./panes-layout";
import { type PanesMessages, usePanesMessages } from "./panes-messages";
import { preservePanesPreviewScope } from "./panes-preview-scope";
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
  /**
   * The application's own arrangement. "Reset arrangement" in the Arrange menu returns to it, choosing its preset
   * restores its sizes, and a double click on a boundary restores that boundary's size.
   */
  defaultLayout?: PanesLayout;
  /**
   * The one-time hint at the first tab grip that panes can be arranged. The application decides on the server
   * whether it was seen and stores the dismissal, so a dismissed hint never renders again.
   */
  arrangeHint?: { open: boolean; onDismiss: () => void };
  ariaLabel?: string;
  class?: string;
};

/** Below this width of its own container, Panes shows every item as one row of tabs and never stores that. */
export const PANES_NARROW_WIDTH = 640;

const PRESET_ICONS: Record<PanesPreset, string> = {
  two: "ti ti-layout-columns",
  three: "ti ti-columns-3",
  stacked: "ti ti-layout-board-split",
  tabs: "ti ti-app-window",
};

const SIDE_ICONS = {
  top: "ti ti-layout-navbar",
  bottom: "ti ti-layout-bottombar",
  left: "ti ti-layout-sidebar",
  right: "ti ti-layout-sidebar-right",
} as const;

const MOVE_ORDER: Record<PanesMove["kind"], number> = { split: 0, group: 1, tab: 2 };

/** The group that hosts the Arrange button: the top group at the trailing edge. */
const arrangeHostGroup = (node: PanesNode | null): PanesGroup | null => {
  if (!node) return null;
  if (node.type === "group") return node;
  return arrangeHostGroup(node.direction === "horizontal" ? node.second : node.first);
};

const firstGroupOf = (node: PanesNode | null): PanesGroup | null => {
  if (!node) return null;
  return node.type === "group" ? node : firstGroupOf(node.first);
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
  const panesMessages = usePanesMessages();
  const instanceId = `k2b-panes-${createUniqueId()}`;
  const items = createMemo(() => createItemMap(props.items));
  const layout = createMemo(() => {
    if (!parsePanesLayout(props.layout)) throw new Error("Panes layout must be a valid version 2 layout.");
    for (const id of collectLayoutItemIds(props.layout.root)) requireItem(items(), id);
    return props.layout;
  });
  let rootElement: HTMLDivElement | undefined;
  // A narrow container shows one row of tabs. It is measured after the first render, so server HTML and the first
  // client render agree; a hidden container (width 0) keeps the last answer.
  const [narrow, setNarrow] = createSignal(false);
  onMount(() => {
    const measure = () => {
      const width = rootElement?.getBoundingClientRect().width ?? 0;
      if (width > 0) setNarrow(width < PANES_NARROW_WIDTH);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (rootElement) observer?.observe(rootElement);
    onCleanup(() => observer?.disconnect());
  });
  // The tab the person chose last, by click, focus, or working in its pane: the Arrange menu moves it, and a narrow
  // container opens on it.
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [projectedActive, setProjectedActive] = createSignal<string | null>(null);
  const inLayout = (itemId: string | null) => (itemId !== null && collectLayoutItemIds(layout().root).includes(itemId) ? itemId : null);
  const shown = createMemo(() =>
    narrow()
      ? projectPanesLayout(layout(), inLayout(projectedActive()) ?? inLayout(chosen()) ?? firstGroupOf(layout().root)?.active ?? null)
      : layout(),
  );
  const canMove = () => (props.movable ?? true) && !narrow();
  const canResize = () => props.resizable ?? true;
  const split = () => props.split ?? "both";
  // Presets arrange the open items in the application's order.
  const itemOrder = createMemo(() => {
    const open = new Set(panesItemOrder(layout()));
    return props.items.map((item) => item.id).filter((id) => open.has(id));
  });
  const canArrange = () => canMove() && itemOrder().length > 1;
  const hostGroupKey = createMemo(() => (canArrange() ? (arrangeHostGroup(shown().root)?.items[0] ?? null) : null));
  const menuItemFor = () => inLayout(chosen()) ?? arrangeHostGroup(layout().root)?.active ?? null;
  const tabElementId = (itemId: string) => `${instanceId}-${itemId}-tab`;
  const focusTab = (itemId: string) => queueMicrotask(() => document.getElementById(tabElementId(itemId))?.focus());
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
      if (mode === "pointer") preservePanesPreviewScope(active.element);
      setDragMode(mode);
      setDraggedItemId(active.meta.itemId);
    },
    announcements: {
      dragStart: (active) => panesMessages().pickedUp({ name: active.meta.label }),
      dragOver: (active, over) =>
        over
          ? panesMessages().dragOver({ name: active.meta.label, place: over.meta.label })
          : panesMessages().notOverPane({ name: active.meta.label }),
      drop: (active, over) =>
        over
          ? panesMessages().dropped({ name: active.meta.label, place: over.meta.label })
          : panesMessages().notMoved({ name: active.meta.label }),
      cancel: (active) => panesMessages().cancelled({ name: active.meta.label }),
    },
    onDrop: ({ intent, mode }) => {
      setDragMode(null);
      setDraggedItemId(null);
      if (!intent) return;
      const current = layout();
      const next = applyPanesIntent(current, intent);
      if (next === current) return;
      setChosen(intent.itemId);
      props.onLayoutChange(next);
      if (mode === "keyboard") focusTab(intent.itemId);
    },
    onCancel: () => {
      setDragMode(null);
      setDraggedItemId(null);
    },
  });
  const activate = (itemId: string) => {
    setChosen(itemId);
    if (narrow()) {
      setProjectedActive(itemId);
      return;
    }
    // A choice in the wide layout is newer than one in the narrow row.
    setProjectedActive(null);
    const current = layout();
    const next = activatePanesItem(current, itemId);
    if (next !== current) props.onLayoutChange(next);
  };
  const requestAdd = (targetItemId: string | null) => props.onAddItem?.(targetItemId);

  const title = (itemId: string) => requireItem(items(), itemId).title;
  const moveLabel = (move: PanesMove, messages: PanesMessages): string => {
    if (move.kind === "split") return messages.moveBeside({ side: move.side, name: title(move.targetItemId) });
    if (move.kind === "group") return messages.moveIntoGroup({ name: title(move.targetItemId) });
    return move.direction === "previous" ? messages.moveTabPrevious : messages.moveTabNext;
  };
  const move = (itemId: string, intent: PanesIntent, place: string) => {
    const current = layout();
    const next = applyPanesIntent(current, intent);
    if (next === current) return;
    setChosen(itemId);
    props.onLayoutChange(next);
    focusTab(itemId);
    announce(panesMessages().moved({ name: title(itemId), place }));
  };
  const moveWithinGroup = (itemId: string, direction: "previous" | "next"): boolean => {
    const step = getPanesMoves(layout(), itemId, { movable: canMove(), split: split() }).find(
      (entry) => entry.kind === "tab" && entry.direction === direction,
    );
    if (!step) return false;
    move(itemId, step.intent, moveLabel(step, panesMessages()));
    return true;
  };
  const arrange = (preset: PanesPreset, itemId: string | null) => {
    const next = applyPanesPreset(preset, itemOrder(), { active: itemId ?? undefined, fallback: props.defaultLayout });
    // Choosing the current preset again restores its sizes.
    if (!next || samePanesSizes(next, layout())) return;
    props.onLayoutChange(next);
    if (itemId) focusTab(itemId);
    announce(panesMessages().arranged({ preset: panesMessages().preset({ preset }) }));
  };
  // A default that names other items than the open ones, such as a pane the application closed, cannot be restored.
  const resettable = () => {
    const fallback = props.defaultLayout;
    if (!fallback) return false;
    const open = panesItemOrder(layout()).toSorted();
    const stored = panesItemOrder(fallback).toSorted();
    return open.length === stored.length && open.every((id, index) => id === stored[index]);
  };
  const reset = (itemId: string | null) => {
    const fallback = props.defaultLayout;
    if (!fallback || !resettable() || samePanesSizes(fallback, layout())) return;
    props.onLayoutChange(fallback);
    const focus = itemId && collectLayoutItemIds(fallback.root).includes(itemId) ? itemId : null;
    if (focus) focusTab(focus);
  };
  const menuItems = (itemId: string | null): DropdownItem[] => {
    const messages = panesMessages();
    const current = layout();
    const order = itemOrder();
    const selected = getPanesPreset(current, order);
    const sections: DropdownItem[] = [];
    const presets = PANES_PRESETS.filter((preset) => canApplyPanesPreset(preset, order.length, split()));
    if (presets.length > 0) {
      sections.push({
        sectionLabel: messages.arrangement,
        layout: "tiles",
        items: presets.map((preset) => ({
          choice: "radio" as const,
          label: messages.preset({ preset }),
          icon: PRESET_ICONS[preset],
          checked: selected === preset,
          action: () => arrange(preset, itemId),
        })),
      });
    }
    if (itemId) {
      const moves = getPanesMoves(current, itemId, { movable: canMove(), split: split() }).sort(
        (left, right) => MOVE_ORDER[left.kind] - MOVE_ORDER[right.kind],
      );
      if (moves.length > 0) {
        sections.push({
          sectionLabel: messages.moveNamed({ name: title(itemId) }),
          items: moves.map((entry) => {
            const label = moveLabel(entry, messages);
            return {
              label,
              icon:
                entry.kind === "split"
                  ? SIDE_ICONS[entry.side]
                  : entry.kind === "group"
                    ? "ti ti-arrows-move"
                    : entry.direction === "previous"
                      ? "ti ti-arrow-left"
                      : "ti ti-arrow-right",
              trailing:
                entry.kind === "tab" ? (
                  <kbd class="k2b-panes__shortcut">{`${messages.ctrlKey} ⇧ ${entry.direction === "previous" ? "←" : "→"}`}</kbd>
                ) : undefined,
              action: () => move(itemId, entry.intent, label),
            };
          }),
        });
      }
    }
    if (resettable()) {
      const atDefault = samePanesSizes(props.defaultLayout!, current);
      sections.push({
        items: [
          atDefault
            ? { label: messages.resetArrangement, icon: "ti ti-restore", disabled: true as const }
            : { label: messages.resetArrangement, icon: "ti ti-restore", action: () => reset(itemId) },
        ],
      });
    }
    return sections;
  };
  // One menu for right clicks, Shift+F10 and the hint; the Arrange button has its own trigger with the same entries.
  const [contextItemId, setContextItemId] = createSignal<string | null>(null);
  let openContextMenu: ((anchor: DropdownAnchor, returnFocus?: DropdownReturnFocus) => void) | undefined;
  const openMenu = (itemId: string | null, anchor: DropdownAnchor, returnFocus?: DropdownReturnFocus) => {
    if (!canArrange()) return;
    if (itemId) setChosen(itemId);
    setContextItemId(itemId);
    openContextMenu?.(anchor, returnFocus);
  };
  let firstGrip: HTMLElement | undefined;
  let arrangeButton: HTMLElement | undefined;

  return (
    <div
      ref={rootElement}
      class={`k2b-panes ${props.class ?? ""}`}
      data-k2b-panes
      data-narrow={narrow() ? "true" : undefined}
      role="group"
      aria-label={props.ariaLabel ?? panesMessages().paneWorkspace}
    >
      <Show
        when={shown().root}
        fallback={
          <div class="k2b-panes__empty">
            <span class="k2b-panes__empty-mark" aria-hidden="true">
              <i class="ti ti-layout-columns" />
            </span>
            <p>{panesMessages().noPane}</p>
            <Show when={props.onAddItem !== undefined}>
              <button type="button" class="k2b-panes__add" onClick={() => requestAdd(null)} aria-label={panesMessages().addPane}>
                <i class="ti ti-plus" aria-hidden="true" />
                <span>{panesMessages().addPane}</span>
              </button>
            </Show>
          </div>
        }
      >
        {(root) => (
          <PanesNodeRenderer
            node={root}
            path={[]}
            layout={shown}
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
            defaultRatio={(path, direction) =>
              (props.defaultLayout && samePanesArrangement(props.defaultLayout, layout())
                ? getPanesSplitRatio(props.defaultLayout, path, direction)
                : null) ?? 0.5
            }
            onChoose={setChosen}
            onMenu={openMenu}
            onMoveWithinGroup={moveWithinGroup}
            hostGroupKey={hostGroupKey}
            arrange={() => (
              <Dropdown
                items={menuItems(menuItemFor())}
                position="bottom-right"
                label={panesMessages().arrange}
                note={panesMessages().arrangeNote}
                menuClass="k2b-panes__menu"
                lazy
              >
                <Dropdown.Trigger
                  ref={(element: HTMLButtonElement) => {
                    arrangeButton = element;
                  }}
                  class="k2b-panes__arrange"
                  variant="ghost"
                  size="sm"
                  tooltip={false}
                >
                  <i class="ti ti-layout-columns" aria-hidden="true" />
                  <span>{panesMessages().arrange}</span>
                </Dropdown.Trigger>
              </Dropdown>
            )}
            registerFirstGrip={(element) => {
              firstGrip = element;
            }}
          />
        )}
      </Show>
      <Dropdown
        items={menuItems(contextItemId())}
        label={panesMessages().arrange}
        menuClass="k2b-panes__menu"
        lazy
        openAt={(open) => {
          openContextMenu = open;
        }}
      />
      <Show when={props.arrangeHint && canArrange()}>
        <MovedHint
          // Hidden while a tab is dragged, so it never covers a drop target; it comes back afterwards.
          open={(props.arrangeHint?.open ?? false) && draggedItemId() === null}
          onDismiss={() => props.arrangeHint?.onDismiss()}
          target={() => firstGrip}
          action={{
            label: panesMessages().arrange,
            onClick: () => {
              const button = arrangeButton;
              if (button) openMenu(menuItemFor(), button, button);
            },
          }}
        >
          <strong>{panesMessages().arrangeHint}</strong> {panesMessages().arrangeHintDetail}
        </MovedHint>
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
  defaultRatio: (path: PanesPath, direction: PanesSplit["direction"]) => number;
  onChoose: (itemId: string) => void;
  onMenu: (itemId: string | null, anchor: DropdownAnchor, returnFocus?: DropdownReturnFocus) => void;
  onMoveWithinGroup: (itemId: string, direction: "previous" | "next") => boolean;
  /** The first item of the group that shows the Arrange button, or `null` when there is none. */
  hostGroupKey: () => string | null;
  arrange: () => JSX.Element;
  registerFirstGrip: (element: HTMLElement) => void;
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
  const panesMessages = usePanesMessages();
  let container: HTMLDivElement | undefined;
  let separatorElement: HTMLButtonElement | undefined;
  let stopResize: (() => void) | undefined;
  let finishResize: (() => void) | undefined;
  const [resizing, setResizing] = createSignal(false);
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
    if (!props.canResize() || event.button !== 0) return;
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
    const releaseTextSelection = suppressTextSelection(pointerId);
    setResizing(true);
    stopResize = () => {
      setResizing(false);
      releaseTextSelection();
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
  const resetRatio = () => {
    if (props.canResize()) commitRatio(props.defaultRatio(props.path, props.node().direction));
  };
  const onResizeKeyDown = (event: KeyboardEvent) => {
    if (!props.canResize()) return;
    if (event.key === "Enter") {
      event.preventDefault();
      resetRatio();
      return;
    }
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
        aria-label={panesMessages().resizePanes}
        aria-keyshortcuts={props.canResize() ? "Enter" : undefined}
        data-active={resizing() ? "true" : undefined}
        onPointerDown={startResize}
        onKeyDown={onResizeKeyDown}
        onDblClick={resetRatio}
      >
        <span aria-hidden="true" />
      </button>
      <Show when={props.canResize()}>
        <Tooltip
          content={panesMessages().resizeHint({ direction: props.node().direction })}
          target={() => separatorElement}
          placement={props.node().direction === "horizontal" ? "right" : "bottom"}
        />
      </Show>
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
  const panesMessages = usePanesMessages();
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
  const [scrollbar, setScrollbar] = createSignal({ overflow: false, left: 0, width: 0, track: 0 });
  const syncScrollbar = () => {
    if (!tabsElement) return;
    const { clientWidth, scrollLeft, scrollWidth } = tabsElement;
    if (scrollWidth <= clientWidth || clientWidth <= 0) {
      setScrollbar({ overflow: false, left: 0, width: 0, track: 0 });
      return;
    }
    const width = Math.min(clientWidth, Math.max(24, (clientWidth * clientWidth) / scrollWidth));
    const left = (scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - width);
    // The track spans the tab row only, not the Arrange button beside it, so thumb and drag share one range.
    setScrollbar({ overflow: true, left, width, track: clientWidth });
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
    if (event.button !== 0) return;
    event.preventDefault();
    const track = event.currentTarget;
    const current = scrollbar();
    scrollbarDragOffset =
      event.target === track
        ? current.width / 2
        : Math.min(current.width, Math.max(0, event.clientX - track.getBoundingClientRect().left - current.left));
    track.setPointerCapture(event.pointerId);
    // The track's own pointerup or pointercancel ends the hold.
    suppressTextSelection(event.pointerId);
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
  const isHost = () => props.hostGroupKey() !== null && props.hostGroupKey() === itemIds()[0];
  const isFirstGroup = () => props.path.every((segment) => segment === "first");
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
    if (props.canMove() && ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) {
      event.preventDefault();
      const tab = event.currentTarget as HTMLElement;
      props.onMenu(itemId, tab, () => document.getElementById(tabId(itemId)) ?? undefined);
      return;
    }
    // The reorder keys never fall through to tab navigation, also at either end where the tab cannot move.
    if (
      props.canMove() &&
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      props.onMoveWithinGroup(itemId, event.key === "ArrowLeft" ? "previous" : "next");
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
    if (target.kind === "group") return panesMessages().addToNamed({ name: targetItem.title });
    if (target.kind === "tab") {
      const before = target.beforeItemId ? requireItem(props.itemById(), target.beforeItemId) : null;
      return before ? panesMessages().insertBeforeNamed({ name: before.title }) : panesMessages().insertAtEnd;
    }
    return target.side
      ? panesMessages().addPaneSide({ side: target.side, name: targetItem.title })
      : panesMessages().addToNamed({ name: targetItem.title });
  };
  return (
    <section class="k2b-panes__group" data-arrange={isHost() ? "true" : undefined}>
      <div class="k2b-panes__head">
        <div
          ref={tabsElement}
          class="k2b-panes__tabs"
          role="tablist"
          aria-label={panesMessages().paneTabs}
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
                    aria-haspopup={props.canMove() ? "menu" : undefined}
                    onContextMenu={(event) => {
                      if (!props.canMove()) return;
                      event.preventDefault();
                      props.onMenu(
                        itemId,
                        { getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0) },
                        () => document.getElementById(tabId(itemId)) ?? undefined,
                      );
                    }}
                    onFocus={() => props.onChoose(itemId)}
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
                    <Show when={props.canMove()}>
                      <i
                        ref={(element) => {
                          if (index() === 0 && isFirstGroup()) props.registerFirstGrip(element);
                        }}
                        class="ti ti-grip-vertical k2b-panes__grip"
                        aria-hidden="true"
                      />
                    </Show>
                    <span class="k2b-ui k2b-panes__drag-surface k2b-panes__drag-preview" data-dnd-preview>
                      <i class={`${iconClass(item().icon)} k2b-panes__icon`} aria-hidden="true" />
                      <span>{item().title}</span>
                    </span>
                  </button>
                  <Show when={item().onClose !== undefined}>
                    <Tooltip.Trigger
                      type="button"
                      class="k2b-panes__close"
                      content={messages().closeNamed({ name: item().title })}
                      aria-label={messages().closeNamed({ name: item().title })}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        item().onClose?.();
                      }}
                    >
                      <i class="ti ti-x" aria-hidden="true" />
                    </Tooltip.Trigger>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={targetAtEnd()}>
            {(target) => <PanesDropTargetView target={target()} label={targetLabel(target())} dnd={props.dnd} placement="tab-end" />}
          </Show>
          <Show when={props.canAdd()}>
            <Tooltip.Trigger
              type="button"
              class="k2b-panes__add k2b-panes__add--tab"
              aria-label={panesMessages().addPane}
              content={panesMessages().addPane}
              onClick={() => props.addItem(props.node().active)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </Tooltip.Trigger>
          </Show>
        </div>
        <Show when={isHost()}>{props.arrange()}</Show>
      </div>
      <Show when={scrollbar().overflow}>
        <div
          class="k2b-panes__tabs-scrollbar"
          style={{ width: `${scrollbar().track}px`, right: "auto" }}
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
      {/* Working in a pane chooses it, so Arrange acts on the pane the person is in. */}
      <div class="k2b-panes__body" onFocusIn={() => props.onChoose(props.node().active)}>
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
