import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

export type DndId = string;

export type DndPointer = {
  x: number;
  y: number;
};

export type DndDraggableConfig<TDragMeta> = {
  id: DndId;
  meta: TDragMeta;
  disabled?: boolean;
  /**
   * If false, this element is not added to tab order automatically.
   * Useful when a draggable wraps its own interactive focus targets (e.g. links/buttons).
   */
  focusable?: boolean;
  /** Enables keyboard drag controls (Space/Enter/Escape/Arrows). */
  keyboard?: boolean;
  /** Optional CSS selector that must match the pointerdown target (or one of its ancestors) to start drag. */
  handleSelector?: string;
  /**
   * Optional inline `touch-action` while mounted (for example `"none"` on a dedicated drag handle).
   * Omit to preserve the element's existing touch/scroll behavior.
   */
  touchAction?: string;
};

export type DndDroppableConfig<TDropMeta> = {
  id: DndId;
  meta: TDropMeta;
  disabled?: boolean;
};

export type DndDraggableSnapshot<TDragMeta> = {
  id: DndId;
  meta: TDragMeta;
  element: HTMLElement;
  rect: DOMRectReadOnly;
};

export type DndDroppableSnapshot<TDropMeta> = {
  id: DndId;
  meta: TDropMeta;
  element: HTMLElement;
  rect: DOMRectReadOnly;
  center: DndPointer;
  containsPointer: boolean;
  distance: number;
};

export type DndCollisionContext<TDragMeta, TDropMeta, TIntent> = {
  active: DndDraggableSnapshot<TDragMeta>;
  pointer: DndPointer;
  droppables: DndDroppableSnapshot<TDropMeta>[];
  previousOverId: DndId | null;
  previousIntent: TIntent | null;
};

export type DndBuildIntentContext<TDragMeta, TDropMeta, TIntent> = {
  active: DndDraggableSnapshot<TDragMeta>;
  over: DndDroppableSnapshot<TDropMeta> | null;
  pointer: DndPointer;
  previousIntent: TIntent | null;
};

export type DndEventContext<TDragMeta, TDropMeta, TIntent> = {
  mode: "pointer" | "keyboard";
  active: DndDraggableSnapshot<TDragMeta>;
  over: DndDroppableSnapshot<TDropMeta> | null;
  intent: TIntent | null;
  pointer: DndPointer;
};

export type DndCreateOptions<TDragMeta, TDropMeta, TIntent> = {
  activationDistance?: number;
  touchActivationDelayMs?: number;
  collisionDetector?: (ctx: DndCollisionContext<TDragMeta, TDropMeta, TIntent>) => DndId | null;
  buildIntent?: (ctx: DndBuildIntentContext<TDragMeta, TDropMeta, TIntent>) => TIntent | null;
  isSameIntent?: (a: TIntent | null, b: TIntent | null) => boolean;
  onDragStart?: (ctx: DndEventContext<TDragMeta, TDropMeta, TIntent>) => void;
  onDragOver?: (ctx: DndEventContext<TDragMeta, TDropMeta, TIntent>) => void;
  onDrop?: (ctx: DndEventContext<TDragMeta, TDropMeta, TIntent>) => void;
  onCancel?: (ctx: DndEventContext<TDragMeta, TDropMeta, TIntent>) => void;
  announcements?: {
    dragStart?: (active: DndDraggableSnapshot<TDragMeta>) => string;
    dragOver?: (active: DndDraggableSnapshot<TDragMeta>, over: DndDroppableSnapshot<TDropMeta> | null) => string;
    drop?: (active: DndDraggableSnapshot<TDragMeta>, over: DndDroppableSnapshot<TDropMeta> | null) => string;
    cancel?: (active: DndDraggableSnapshot<TDragMeta>) => string;
  };
};

export type DndController<TDragMeta, TDropMeta, TIntent> = {
  draggable: (el: HTMLElement, accessor: Accessor<DndDraggableConfig<TDragMeta>>) => void;
  droppable: (el: HTMLElement, accessor: Accessor<DndDroppableConfig<TDropMeta>>) => void;
  activeId: Accessor<DndId | null>;
  overId: Accessor<DndId | null>;
  intent: Accessor<TIntent | null>;
  isDragging: Accessor<boolean>;
  cancel: () => void;
  destroy: () => void;
};

type DraggableRecord<TDragMeta> = {
  id: DndId;
  element: HTMLElement;
  getConfig: () => DndDraggableConfig<TDragMeta>;
};

type DroppableRecord<TDropMeta> = {
  id: DndId;
  element: HTMLElement;
  getConfig: () => DndDroppableConfig<TDropMeta>;
};

type ActiveDrag<TDragMeta> = {
  mode: "pointer" | "keyboard";
  pointerId: number | null;
  pointerType: string | null;
  offsetX: number;
  offsetY: number;
  sourceOpacity: string;
  source: DraggableRecord<TDragMeta>;
  snapshot: DndDraggableSnapshot<TDragMeta>;
};

type PendingPointer<TDragMeta> = {
  record: DraggableRecord<TDragMeta>;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  startedAt: number;
  offsetX: number;
  offsetY: number;
};

const DEFAULT_ACTIVATION_DISTANCE = 6;
const DEFAULT_TOUCH_DELAY = 120;

const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return !!target.closest("button, a, input, textarea, select, [contenteditable='true'], [data-dnd-ignore]");
};

const defaultIntentComparator = <TIntent,>(a: TIntent | null, b: TIntent | null) => a === b;

const defaultCollisionDetector = <TDragMeta, TDropMeta, TIntent>(
  ctx: DndCollisionContext<TDragMeta, TDropMeta, TIntent>,
): DndId | null => {
  if (ctx.droppables.length === 0) return null;
  const pointerHits = ctx.droppables.filter((entry) => entry.containsPointer);
  const pool = pointerHits.length > 0 ? pointerHits : ctx.droppables;
  let winner = pool[0]!;
  for (const candidate of pool) {
    if (candidate.distance < winner.distance) {
      winner = candidate;
    }
  }
  return winner.id;
};

const sortDroppablesForKeyboard = <TDropMeta,>(entries: DndDroppableSnapshot<TDropMeta>[]) =>
  [...entries].sort((a, b) => {
    const vertical = a.rect.top - b.rect.top;
    if (Math.abs(vertical) > 8) return vertical;
    return a.rect.left - b.rect.left;
  });

/** Creates an off-screen ARIA live region for announcing drag events to screen readers. */
const createLiveRegion = () => {
  // Guard for SSR / jsdom: `document.body` is null in some test environments
  // and in some SSR setups even when `document` is defined. A null-check on
  // `document` alone wasn't enough — we'd throw at `appendChild`.
  if (typeof document === "undefined" || !document.body) {
    return { announce: (_message: string) => {}, destroy: () => {} };
  }

  const element = document.createElement("div");
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  element.style.position = "fixed";
  element.style.width = "1px";
  element.style.height = "1px";
  element.style.padding = "0";
  element.style.margin = "-1px";
  element.style.overflow = "hidden";
  element.style.clip = "rect(0 0 0 0)";
  element.style.whiteSpace = "nowrap";
  element.style.border = "0";
  document.body.appendChild(element);

  let active = true;
  const announce = (message: string) => {
    if (!active) return;
    element.textContent = "";
    queueMicrotask(() => {
      if (!active) return;
      element.textContent = message;
    });
  };

  const destroy = () => {
    active = false;
    element.remove();
  };

  return { announce, destroy };
};

/** Clones the source element (or its `[data-dnd-preview]` child) into a fixed-position ghost overlay for pointer drags. */
const createGhost = (source: HTMLElement) => {
  if (typeof document === "undefined" || !document.body) return null;
  const preview = source.querySelector<HTMLElement>("[data-dnd-preview]") ?? source;
  const rect = preview.getBoundingClientRect();
  const previewStyle = getComputedStyle(preview);
  const clone = preview.cloneNode(true) as HTMLElement;
  // Strip id attributes from the clone tree — keeping them would create
  // duplicate DOM IDs during the drag, breaking `<label for="…">` matching,
  // `aria-labelledby` linkage, and browser anchor navigation.
  if (clone.hasAttribute("id")) clone.removeAttribute("id");
  clone.querySelectorAll<HTMLElement>("[id]").forEach((el) => el.removeAttribute("id"));
  const count = Number(preview.dataset.dndCount ?? "0");
  clone.style.position = "fixed";
  clone.style.top = `${rect.top}px`;
  clone.style.left = `${rect.left}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.pointerEvents = "none";
  clone.style.zIndex = "9999";
  clone.style.margin = "0";
  clone.style.transform = "translate3d(0,0,0)";
  clone.style.opacity = "0.92";
  clone.style.boxShadow = "var(--stdlib-dnd-ghost-shadow, 0 12px 28px rgba(0, 0, 0, 0.28))";
  clone.style.borderRadius = previewStyle.borderRadius;
  clone.style.overflow = previewStyle.overflow;
  clone.style.willChange = "transform";
  clone.setAttribute("aria-hidden", "true");
  if (Number.isFinite(count) && count > 1) {
    const badge = document.createElement("span");
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.position = "absolute";
    badge.style.top = "0.25rem";
    badge.style.right = "0.25rem";
    badge.style.minWidth = "1.25rem";
    badge.style.height = "1.25rem";
    badge.style.padding = "0 0.375rem";
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.justifyContent = "center";
    badge.style.borderRadius = "999px";
    badge.style.background = "var(--stdlib-dnd-badge-bg, rgb(59 130 246))";
    badge.style.color = "white";
    badge.style.fontSize = "10px";
    badge.style.fontWeight = "600";
    badge.style.lineHeight = "1";
    badge.style.boxShadow = "var(--stdlib-dnd-badge-shadow, 0 6px 16px rgba(37, 99, 235, 0.35))";
    clone.appendChild(badge);
  }
  document.body.appendChild(clone);
  return clone;
};

const getPointerFromEvent = (event: PointerEvent): DndPointer => ({ x: event.clientX, y: event.clientY });

/**
 * Creates a drag-and-drop controller with pointer and keyboard support.
 *
 * Provides `draggable` and `droppable` SolidJS directives, reactive signals for
 * active/over state and intent, plus `cancel` and `destroy` controls.
 *
 * @assumption Must be called inside a SolidJS reactive owner (component or createRoot)
 *   because the returned directives use `createEffect` and `onCleanup` internally.
 *
 * Side effects:
 * - Attaches `pointermove`, `pointerup`, and `pointercancel` listeners on `window`
 *   while a drag is pending or active.
 * - Mutates DOM: sets `opacity`, `data-dnd-active`, `data-dnd-*` attributes,
 *   `tabindex`, optional configured `touch-action`, and `user-select` on source
 *   elements and `document.documentElement`.
 *   `aria-grabbed` is also set for backward compatibility but is deprecated
 *   (removed from ARIA 1.2); target `[data-dnd-active]` in new CSS.
 * - Appends a ghost element and an ARIA live region to `document.body`.
 * - All listeners and DOM mutations are cleaned up on `destroy()` or component unmount.
 *
 * @returns A controller object with directives (`draggable`, `droppable`), reactive
 *   signals (`activeId`, `overId`, `intent`, `isDragging`), and control functions
 *   (`cancel`, `destroy`).
 *
 * @example
 * ```tsx
 * const { draggable, droppable, isDragging, activeId, overId } = dnd.create({
 *   onDrop: ({ active, over }) => reorder(active.id, over?.id),
 * });
 *
 * <div use:draggable={{ id: "item-1", meta: item1 }}>Drag me</div>
 * <div use:droppable={{ id: "zone-a", meta: zoneA }}>Drop here</div>
 * ```
 */
const createDnd = <TDragMeta, TDropMeta, TIntent>(
  options: DndCreateOptions<TDragMeta, TDropMeta, TIntent> = {},
): DndController<TDragMeta, TDropMeta, TIntent> => {
  // Validate numeric options — NaN / Infinity / negative values would
  // either disable activation entirely or hang the touch-delay check.
  const validatePositiveNumber = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`dnd.create: ${name} must be a non-negative finite number (got ${value})`);
    }
    return value;
  };
  const activationDistance = validatePositiveNumber(
    options.activationDistance,
    DEFAULT_ACTIVATION_DISTANCE,
    "activationDistance",
  );
  const touchActivationDelayMs = validatePositiveNumber(
    options.touchActivationDelayMs,
    DEFAULT_TOUCH_DELAY,
    "touchActivationDelayMs",
  );

  /** Set to true when destroy() runs. Subsequent pointer/key events are
   *  no-ops so a destroyed controller doesn't react to anything. */
  let destroyed = false;
  const detectCollision = options.collisionDetector ?? defaultCollisionDetector;
  const compareIntent = options.isSameIntent ?? defaultIntentComparator<TIntent>;

  const draggables = new Map<DndId, DraggableRecord<TDragMeta>>();
  const droppables = new Map<DndId, DroppableRecord<TDropMeta>>();

  const [activeId, setActiveId] = createSignal<DndId | null>(null);
  const [overId, setOverId] = createSignal<DndId | null>(null);
  const [intent, setIntent] = createSignal<TIntent | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);

  let activeDrag: ActiveDrag<TDragMeta> | null = null;
  let pendingPointer: PendingPointer<TDragMeta> | null = null;
  let pointer = { x: 0, y: 0 } satisfies DndPointer;
  let keyboardOverIndex = 0;
  let ghost: HTMLElement | null = null;
  let restoreUserSelect: (() => void) | null = null;
  let touchActivationTimer: ReturnType<typeof setTimeout> | null = null;
  const directiveCleanups = new Set<() => void>();
  const liveRegion = createLiveRegion();

  const announce = (message: string | null | undefined) => {
    if (!message) return;
    liveRegion.announce(message);
  };

  /** Runs user code without letting it interrupt the controller state machine. */
  const safeCompute = <TArgs extends unknown[], TResult>(
    fn: ((...args: TArgs) => TResult) | undefined,
    args: TArgs,
    fallback: TResult,
    label: string,
  ): TResult => {
    if (!fn) return fallback;
    try {
      return fn(...args);
    } catch (error) {
      console.error(`dnd: ${label} threw:`, error);
      return fallback;
    }
  };

  const safeCall = <T extends unknown[]>(
    fn: ((...args: T) => void) | undefined,
    args: T,
    label: string,
  ): void => {
    safeCompute(fn, args, undefined, label);
  };

  const safeAnnouncement = <T extends unknown[]>(
    fn: ((...args: T) => string) | undefined,
    args: T,
    label: string,
  ) => {
    announce(safeCompute(fn, args, "", label));
  };

  const getDroppableSnapshots = (currentPointer: DndPointer): DndDroppableSnapshot<TDropMeta>[] => {
    const entries: DndDroppableSnapshot<TDropMeta>[] = [];
    for (const record of droppables.values()) {
      const config = record.getConfig();
      if (config.disabled) continue;
      const rect = record.element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const containsPointer =
        currentPointer.x >= rect.left &&
        currentPointer.x <= rect.right &&
        currentPointer.y >= rect.top &&
        currentPointer.y <= rect.bottom;
      const dx = currentPointer.x - center.x;
      const dy = currentPointer.y - center.y;
      entries.push({
        id: config.id,
        meta: config.meta,
        element: record.element,
        rect,
        center,
        containsPointer,
        distance: Math.sqrt(dx * dx + dy * dy),
      });
    }
    return entries;
  };

  const updateGhost = (currentPointer: DndPointer) => {
    if (!ghost || !activeDrag) return;
    const x = currentPointer.x - activeDrag.offsetX;
    const y = currentPointer.y - activeDrag.offsetY;
    ghost.style.transform = `translate3d(${x - activeDrag.snapshot.rect.left}px, ${y - activeDrag.snapshot.rect.top}px, 0)`;
  };

  const emitDragOver = () => {
    if (!activeDrag) return;

    const droppableSnapshots = getDroppableSnapshots(pointer);
    const nextOverId =
      droppableSnapshots.length === 0
        ? null
        : safeCompute(
            detectCollision,
            [
              {
                active: activeDrag.snapshot,
                pointer,
                droppables: droppableSnapshots,
                previousOverId: overId(),
                previousIntent: intent(),
              },
            ],
            null,
            "collisionDetector",
          );
    const nextOver = nextOverId ? droppableSnapshots.find((entry) => entry.id === nextOverId) ?? null : null;

    const nextIntent = options.buildIntent
      ? safeCompute(
          options.buildIntent,
          [
            {
              active: activeDrag.snapshot,
              over: nextOver,
              pointer,
              previousIntent: intent(),
            },
          ],
          null,
          "buildIntent",
        )
      : null;

    const overChanged = nextOverId !== overId();
    if (overChanged) {
      setOverId(nextOverId);
      safeAnnouncement(options.announcements?.dragOver, [activeDrag.snapshot, nextOver], "announcements.dragOver");
    }

    const intentChanged = !safeCompute(compareIntent, [intent(), nextIntent], false, "isSameIntent");
    if (intentChanged) {
      setIntent(() => nextIntent);
    }

    // Gate the user callback by actual state change. Previously this fired
    // every animation frame even when over/intent didn't change — spammy and
    // expensive when consumers do work inside onDragOver.
    if (overChanged || intentChanged) {
      safeCall(
        options.onDragOver,
        [
          {
            mode: activeDrag.mode,
            active: activeDrag.snapshot,
            over: nextOver,
            intent: nextIntent,
            pointer,
          },
        ],
        "onDragOver",
      );
    }
  };

  const clearPointerListeners = () => {
    // Guard for SSR: destroy() may run during server-side cleanNode where
    // `window` is undefined. There are no listeners to remove server-side
    // because the activation path that attaches them only runs on a real
    // user pointer event. Same defensive-no-op pattern as createLiveRegion
    // and lockSelection above.
    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerCancel);
  };

  const clearGhost = () => {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
  };

  const clearTouchActivationTimer = () => {
    if (touchActivationTimer === null) return;
    clearTimeout(touchActivationTimer);
    touchActivationTimer = null;
  };

  /**
   * Temporarily disables global text selection while pointer-drag is pending/active.
   * This prevents accidental full-page text highlights during drag gestures.
   */
  const lockSelection = () => {
    if (typeof document === "undefined" || restoreUserSelect) return;
    const root = document.documentElement;
    const prevUserSelect = root.style.userSelect;
    const prevWebkitUserSelect = root.style.webkitUserSelect;
    root.style.userSelect = "none";
    root.style.webkitUserSelect = "none";
    restoreUserSelect = () => {
      root.style.userSelect = prevUserSelect;
      root.style.webkitUserSelect = prevWebkitUserSelect;
      restoreUserSelect = null;
    };
  };

  const unlockSelection = () => {
    restoreUserSelect?.();
  };

  const resetSourceOpacity = () => {
    if (!activeDrag) return;
    activeDrag.source.element.style.opacity = activeDrag.sourceOpacity;
  };

  const releasePointerCapture = () => {
    if (!activeDrag || activeDrag.pointerId === null) return;
    try {
      activeDrag.source.element.releasePointerCapture(activeDrag.pointerId);
    } catch {
      // Pointer capture may already have ended or the source may be detached.
    }
  };

  const clearSession = () => {
    clearTouchActivationTimer();
    clearGhost();
    resetSourceOpacity();
    releasePointerCapture();
    activeDrag = null;
    pendingPointer = null;
    unlockSelection();
    setIsDragging(false);
    setActiveId(null);
    setOverId(null);
    setIntent(null);
    pointer = { x: 0, y: 0 };
  };

  /** Initializes an active drag session: snapshots the source, dims it, creates a ghost (pointer mode), and fires onDragStart. */
  const beginDrag = (params: {
    record: DraggableRecord<TDragMeta>;
    mode: "pointer" | "keyboard";
    pointerId: number | null;
    pointerType: string | null;
    offsetX: number;
    offsetY: number;
  }) => {
    const config = params.record.getConfig();
    if (config.disabled) return;

    const rect = params.record.element.getBoundingClientRect();
    activeDrag = {
      mode: params.mode,
      pointerId: params.pointerId,
      pointerType: params.pointerType,
      offsetX: params.offsetX,
      offsetY: params.offsetY,
      sourceOpacity: params.record.element.style.opacity,
      source: params.record,
      snapshot: {
        id: config.id,
        meta: config.meta,
        element: params.record.element,
        rect,
      },
    };

    params.record.element.style.opacity = "0.35";
    setIsDragging(true);
    setActiveId(config.id);

    if (params.mode === "pointer") {
      ghost = createGhost(params.record.element);
      updateGhost(pointer);
    }

    safeAnnouncement(options.announcements?.dragStart, [activeDrag.snapshot], "announcements.dragStart");

    const initialDroppables = getDroppableSnapshots(pointer);
    const sorted = sortDroppablesForKeyboard(initialDroppables);
    keyboardOverIndex = sorted.findIndex((entry) => entry.id === config.id);
    if (keyboardOverIndex < 0) keyboardOverIndex = 0;

    safeCall(
      options.onDragStart,
      [
        {
          mode: params.mode,
          active: activeDrag.snapshot,
          over: null,
          intent: null,
          pointer,
        },
      ],
      "onDragStart",
    );

    emitDragOver();
  };

  /** Finalizes the drag by firing onDrop with the current over-target and resetting all drag state. */
  const commitDrop = () => {
    if (!activeDrag) return;
    const currentOverId = overId();
    const currentOver = currentOverId
      ? getDroppableSnapshots(pointer).find((entry) => entry.id === currentOverId) ?? null
      : null;

    // No target (pointer released on empty space, or droppable was removed
    // mid-drag) → fire onCancel rather than silently dropping the drag.
    // Previously this was a silent no-op which left consumers without any
    // signal that the drag had ended.
    if (!currentOver) {
      const snapshot = activeDrag.snapshot;
      const mode = activeDrag.mode;
      const ctx = { mode, active: snapshot, over: null, intent: intent(), pointer };
      // Clear state BEFORE invoking the user callback so a synchronous
      // unmount inside the callback can't observe the half-state.
      clearSession();
      safeAnnouncement(options.announcements?.cancel, [snapshot], "announcements.cancel");
      safeCall(options.onCancel, [ctx], "onCancel");
      return;
    }

    const snapshot = activeDrag.snapshot;
    const mode = activeDrag.mode;
    const currentIntent = intent();
    const ctx = { mode, active: snapshot, over: currentOver, intent: currentIntent, pointer };
    // Clear state BEFORE the user callback. Synchronous unmounts inside
    // onDrop previously fired both onDrop and (through onCleanup → cancel)
    // an onCancel for the same drag — contradictory events.
    clearSession();
    safeAnnouncement(options.announcements?.drop, [snapshot, currentOver], "announcements.drop");
    safeCall(options.onDrop, [ctx], "onDrop");
  };

  /** Aborts the current drag, fires onCancel, and resets all drag state. */
  const cancel = () => {
    // Also clear pending-pointer state and window listeners when called
    // before drag activation crosses the threshold (e.g. programmatic cancel
    // via Escape hotkey while pointer is pressed but unmoved).
    if (pendingPointer && !activeDrag) {
      clearTouchActivationTimer();
      pendingPointer = null;
      unlockSelection();
      clearPointerListeners();
      return;
    }
    if (!activeDrag) return;
    const currentOverId = overId();
    const currentOver = currentOverId
      ? getDroppableSnapshots(pointer).find((entry) => entry.id === currentOverId) ?? null
      : null;
    const snapshot = activeDrag.snapshot;
    const mode = activeDrag.mode;
    const ctx = { mode, active: snapshot, over: currentOver, intent: intent(), pointer };
    clearSession();
    clearPointerListeners();
    safeAnnouncement(options.announcements?.cancel, [snapshot], "announcements.cancel");
    safeCall(options.onCancel, [ctx], "onCancel");
  };

  const maybeStartPendingPointerDrag = (pointerId: number) => {
    if (!pendingPointer || activeDrag) return;
    if (pointerId !== pendingPointer.pointerId) return;

    const dx = pointer.x - pendingPointer.startX;
    const dy = pointer.y - pendingPointer.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - pendingPointer.startedAt;

    const delaySatisfied = pendingPointer.pointerType !== "touch" || elapsed >= touchActivationDelayMs;
    if (distance < activationDistance || !delaySatisfied) {
      return;
    }

    const pending = pendingPointer;
    if (pending.record.getConfig().disabled) {
      clearTouchActivationTimer();
      pendingPointer = null;
      unlockSelection();
      clearPointerListeners();
      return;
    }
    clearTouchActivationTimer();
    pendingPointer = null;
    beginDrag({
      record: pending.record,
      mode: "pointer",
      pointerId: pending.pointerId,
      pointerType: pending.pointerType,
      offsetX: pending.offsetX,
      offsetY: pending.offsetY,
    });
  };

  const onWindowPointerMove = (event: PointerEvent) => {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      pointer = getPointerFromEvent(event);
      maybeStartPendingPointerDrag(event.pointerId);
    }

    if (!activeDrag || activeDrag.mode !== "pointer") return;
    if (activeDrag.pointerId !== event.pointerId) return;

    pointer = getPointerFromEvent(event);
    updateGhost(pointer);
    emitDragOver();
    event.preventDefault();
  };

  const onWindowPointerUp = (event: PointerEvent) => {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId && !activeDrag) {
      clearTouchActivationTimer();
      pendingPointer = null;
      unlockSelection();
      clearPointerListeners();
      return;
    }

    if (!activeDrag || activeDrag.mode !== "pointer") return;
    if (activeDrag.pointerId !== event.pointerId) return;

    commitDrop();
    clearPointerListeners();
  };

  const onWindowPointerCancel = (event: PointerEvent) => {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId && !activeDrag) {
      clearTouchActivationTimer();
      pendingPointer = null;
      unlockSelection();
      clearPointerListeners();
      return;
    }

    if (!activeDrag || activeDrag.mode !== "pointer") return;
    if (activeDrag.pointerId !== event.pointerId) return;

    cancel();
    clearPointerListeners();
  };

  const cancelSourceSession = (record: DraggableRecord<TDragMeta>) => {
    if (activeDrag?.source === record) {
      cancel();
      return;
    }
    if (pendingPointer?.record !== record) return;
    clearTouchActivationTimer();
    pendingPointer = null;
    unlockSelection();
    clearPointerListeners();
  };

  const handleKeyboardDrag = (event: KeyboardEvent, record: DraggableRecord<TDragMeta>) => {
    const config = record.getConfig();

    const isTriggerKey = event.key === " " || event.key === "Enter";
    const isArrowKey = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight";

    if (!activeDrag && isTriggerKey) {
      if (config.disabled) return;
      // Anchor the keyboard "pointer" at the element's geometric center so
      // initial collision detection picks up the correct droppable.
      // Previously a hardcoded +4px offset put the cursor in the top-left
      // corner regardless of element size.
      const rect = record.element.getBoundingClientRect();
      pointer = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };

      beginDrag({
        record,
        mode: "keyboard",
        pointerId: null,
        pointerType: "keyboard",
        offsetX: 0,
        offsetY: 0,
      });
      // Stop the trigger from bubbling so stacked draggables don't all
      // attempt to start a drag in sequence.
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!activeDrag || activeDrag.mode !== "keyboard" || activeDrag.source !== record) return;

    if (event.key === "Escape") {
      cancel();
      event.preventDefault();
      return;
    }

    if (isTriggerKey) {
      commitDrop();
      event.preventDefault();
      return;
    }

    if (!isArrowKey) return;

    const sorted = sortDroppablesForKeyboard(getDroppableSnapshots(pointer));
    if (sorted.length === 0) return;

    const currentOverId = overId();
    const currentIndex = currentOverId ? sorted.findIndex((entry) => entry.id === currentOverId) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : keyboardOverIndex;
    const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = Math.min(sorted.length - 1, Math.max(0, startIndex + delta));
    const next = sorted[nextIndex]!;
    keyboardOverIndex = nextIndex;
    pointer = {
      x: next.center.x,
      y: next.center.y,
    };
    emitDragOver();
    event.preventDefault();
  };

  /**
   * SolidJS directive that marks an element as draggable.
   * Binds pointerdown, keydown, and dragstart handlers, manages ARIA attributes,
   * and cleans up on unmount via `onCleanup`.
   *
   * @example
   * ```tsx
   * <div use:draggable={{ id: "item-1", meta: myItem }}>Drag me</div>
   * ```
   */
  const draggable = (element: HTMLElement, accessor: Accessor<DndDraggableConfig<TDragMeta>>) => {
    if (destroyed) return;
    let current = accessor();
    const record: DraggableRecord<TDragMeta> = {
      id: current.id,
      element,
      getConfig: () => current,
    };

    // Warn on duplicate id registration. Previously a silent overwrite that
    // produced confusing "drop fires for wrong item" bugs.
    if (draggables.has(record.id)) {
      console.warn(
        `dnd: duplicate draggable id "${String(record.id)}" — the previous registration will be overwritten`,
      );
    }
    draggables.set(record.id, record);

    const matchesHandleTarget = (target: EventTarget | null, selector: string): boolean => {
      try {
        const candidate =
          target instanceof Element
            ? target
            : target instanceof Node
              ? target.parentElement
              : null;
        return !!candidate?.closest(selector) && element.contains(candidate);
      } catch (error) {
        console.error("dnd: handleSelector invalid:", error);
        return false;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (destroyed) return;
      // Guard against a second pointer triggering a fresh pending-pointer
      // state while another drag (or pending) is in progress. Previously
      // this overwrote `pendingPointer` and re-registered window listeners,
      // leaking handlers and confusing the source-of-drag identity.
      if (activeDrag || pendingPointer) return;
      const config = record.getConfig();
      if (config.disabled) return;
      if (event.button !== 0) return;
      if (event.isPrimary === false) return;

      if (config.handleSelector) {
        if (!matchesHandleTarget(event.target, config.handleSelector)) return;
      } else if (isInteractiveTarget(event.target)) {
        return;
      }

      const rect = element.getBoundingClientRect();
      pointer = getPointerFromEvent(event);
      pendingPointer = {
        record,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: Date.now(),
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      lockSelection();

      if (event.pointerType === "touch" && touchActivationDelayMs > 0) {
        touchActivationTimer = setTimeout(() => {
          touchActivationTimer = null;
          maybeStartPendingPointerDrag(event.pointerId);
        }, touchActivationDelayMs);
      }

      // setPointerCapture routes all subsequent pointer events to this
      // element until the pointer is released, even if it leaves the
      // viewport or the element. Without this we'd miss pointerup events
      // when the user drags off the window.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Older browsers / detached elements may throw — non-fatal.
      }

      window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
      window.addEventListener("pointerup", onWindowPointerUp);
      window.addEventListener("pointercancel", onWindowPointerCancel);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (destroyed) return;
      const config = record.getConfig();
      if (config.keyboard === false) return;
      if (!activeDrag) {
        if (config.handleSelector && !matchesHandleTarget(event.target, config.handleSelector)) return;
        if (!config.handleSelector && event.target !== element && isInteractiveTarget(event.target)) return;
      }
      handleKeyboardDrag(event, record);
    };

    // Disable browser-native drag previews (e.g. links/images) so DnD stays app-controlled.
    const onDragStart = (event: DragEvent) => {
      if (destroyed) return;
      event.preventDefault();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("dragstart", onDragStart);
    element.setAttribute("data-dnd-draggable", "true");

    const previousTabIndex = element.getAttribute("tabindex");
    const prevTouchAction = element.style.touchAction;

    const applyFocusable = (next: DndDraggableConfig<TDragMeta>) => {
      if (next.focusable === false) {
        if (previousTabIndex === null) element.removeAttribute("tabindex");
        else element.setAttribute("tabindex", previousTabIndex);
        return;
      }
      if (element.tabIndex < 0) element.tabIndex = 0;
    };

    const applyTouchAction = (next: DndDraggableConfig<TDragMeta>) => {
      element.style.touchAction = next.touchAction ?? prevTouchAction;
    };

    applyFocusable(current);
    applyTouchAction(current);

    // Mark <img>/<a> descendants as non-draggable so the browser's native
    // drag-and-drop doesn't compete with ours (it would otherwise fire
    // `dragstart` on these elements and start a native ghost-image drag).
    const nativeDraggableChildren = element.querySelectorAll<HTMLElement>("img, a");
    const restoreChildDraggable: Array<{ el: HTMLElement; prev: string | null }> = [];
    nativeDraggableChildren.forEach((el) => {
      restoreChildDraggable.push({ el, prev: el.getAttribute("draggable") });
      el.setAttribute("draggable", "false");
    });

    createEffect(() => {
      const next = accessor();
      if (next.id !== record.id) {
        cancelSourceSession(record);
        if (draggables.get(record.id) === record) draggables.delete(record.id);
        record.id = next.id;
        if (draggables.has(record.id)) {
          console.warn(
            `dnd: duplicate draggable id "${String(record.id)}" — the previous registration will be overwritten`,
          );
        }
        draggables.set(record.id, record);
      }
      current = next;
      if (next.disabled) cancelSourceSession(record);
    });

    createEffect(() => {
      applyFocusable(accessor());
    });

    createEffect(() => {
      applyTouchAction(accessor());
    });

    createEffect(() => {
      const isActive = activeId() === record.id && isDragging();
      // `aria-grabbed` was removed from ARIA 1.2; screen readers ignore it.
      // Still emitted for backward compatibility with existing CSS hooks,
      // but `data-dnd-active` is the future-proof attribute to target.
      element.setAttribute("aria-grabbed", isActive ? "true" : "false");
      element.setAttribute("data-dnd-active", isActive ? "true" : "false");
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      directiveCleanups.delete(cleanup);
      // If this draggable is currently being dragged when its component
      // unmounts, fire cancel BEFORE removing it from the registry — so
      // consumers get a clear "drag aborted" signal rather than a silent
      // disappearance.
      cancelSourceSession(record);
      if (draggables.get(record.id) === record) draggables.delete(record.id);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("dragstart", onDragStart);
      // Clean up DOM attributes / styles so the element doesn't keep
      // dnd-related state after unmount.
      element.removeAttribute("data-dnd-draggable");
      element.removeAttribute("data-dnd-active");
      element.removeAttribute("aria-grabbed");
      if (previousTabIndex === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", previousTabIndex);
      element.style.touchAction = prevTouchAction;
      for (const { el, prev } of restoreChildDraggable) {
        if (prev === null) el.removeAttribute("draggable");
        else el.setAttribute("draggable", prev);
      }
    };
    directiveCleanups.add(cleanup);
    onCleanup(cleanup);
  };

  /**
   * SolidJS directive that marks an element as a drop target.
   * Sets `data-dnd-droppable` and `data-dnd-over` attributes reactively,
   * and cleans up on unmount via `onCleanup`.
   *
   * @example
   * ```tsx
   * <div use:droppable={{ id: "zone-a", meta: zoneA }}>Drop here</div>
   * ```
   */
  const droppable = (element: HTMLElement, accessor: Accessor<DndDroppableConfig<TDropMeta>>) => {
    if (destroyed) return;
    let current = accessor();
    const record: DroppableRecord<TDropMeta> = {
      id: current.id,
      element,
      getConfig: () => current,
    };

    if (droppables.has(record.id)) {
      console.warn(
        `dnd: duplicate droppable id "${String(record.id)}" — the previous registration will be overwritten`,
      );
    }
    droppables.set(record.id, record);
    element.setAttribute("data-dnd-droppable", "true");

    createEffect(() => {
      const next = accessor();
      if (next.id !== record.id) {
        if (droppables.get(record.id) === record) droppables.delete(record.id);
        record.id = next.id;
        if (droppables.has(record.id)) {
          console.warn(
            `dnd: duplicate droppable id "${String(record.id)}" — the previous registration will be overwritten`,
          );
        }
        droppables.set(record.id, record);
      }
      current = next;
    });

    createEffect(() => {
      const isOver = overId() === record.id && isDragging();
      element.setAttribute("data-dnd-over", isOver ? "true" : "false");
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      directiveCleanups.delete(cleanup);
      if (droppables.get(record.id) === record) droppables.delete(record.id);
      element.removeAttribute("data-dnd-droppable");
      element.removeAttribute("data-dnd-over");
    };
    directiveCleanups.add(cleanup);
    onCleanup(cleanup);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    // Always cancel any in-flight drag AND clear pending-pointer state, so
    // an unmount mid-press doesn't leak three window listeners until the
    // user releases. Previously the cleanup only ran when `activeDrag` was
    // set, missing the activation-pending case entirely.
    if (activeDrag) {
      cancel();
    } else if (pendingPointer) {
      clearTouchActivationTimer();
      pendingPointer = null;
      unlockSelection();
      clearPointerListeners();
    }
    unlockSelection();
    clearPointerListeners();
    for (const cleanup of [...directiveCleanups]) cleanup();
    draggables.clear();
    droppables.clear();
    liveRegion.destroy();
  };

  onCleanup(destroy);

  return {
    draggable,
    droppable,
    activeId,
    overId,
    intent,
    isDragging,
    cancel,
    destroy,
  };
};

export const dnd = {
  create: createDnd,
} as const;
