import { installScrollFades } from "./scroll-fade";
import {
  APP_WORKSPACE_DETAIL_MAX,
  APP_WORKSPACE_DETAIL_MIN,
  APP_WORKSPACE_DRAWER_MAX,
  APP_WORKSPACE_DRAWER_MIN,
  APP_WORKSPACE_MAIN_MIN,
  APP_WORKSPACE_PANE_MAX,
  APP_WORKSPACE_PANE_MIN,
  APP_WORKSPACE_SIDEBAR_COLLAPSED,
  APP_WORKSPACE_SIDEBAR_MAX,
  APP_WORKSPACE_SIDEBAR_MIN,
  type AppWorkspaceLayoutState,
  type AppWorkspaceResizeKind,
  appWorkspacePanelVariable,
  appWorkspaceResizeLimits,
  fitAppWorkspacePaneSizes,
  normalizeAppWorkspaceLayoutState,
  resolveAppWorkspaceSidebarWidth,
  safeAppWorkspacePanelId,
  shouldCollapseAppWorkspaceSidebar,
} from "./app-workspace-state";

export type AppWorkspaceControllerOptions = {
  root?: Document | HTMLElement;
  readState?: () => AppWorkspaceLayoutState | null | undefined;
  writeState?: (state: AppWorkspaceLayoutState) => void;
};

type ActiveResize = {
  handle: HTMLElement;
  root: HTMLElement;
  kind: AppWorkspaceResizeKind;
  pointerId: number;
  startClient: number;
  startSize: number;
  liveSize: number;
  moved: boolean;
  direction: 1 | -1;
  previousUserSelect: string;
};

const HANDLE_SELECTOR = "[data-app-workspace-resize]";
const ROOT_SELECTOR = "[data-k2b-app-workspace]";
const LAYOUT_REGION_SELECTOR = [
  ROOT_SELECTOR,
  ".k2b-app-workspace__sidebar",
  ".k2b-app-workspace__main-pane",
  ".k2b-app-workspace__detail",
  ".k2b-app-workspace__drawer",
  HANDLE_SELECTOR,
].join(",");
const LABEL_SELECTOR = ".k2b-app-workspace__sidebar-item-label[data-marquee='true']";
const LABEL_TEXT_SELECTOR = ".k2b-app-workspace__sidebar-item-label-text";
const ITEM_SELECTOR = ".k2b-app-workspace__sidebar-item";
const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));
const eventElement = (event: Event) => (event.target instanceof Element ? event.target : null);
const resizeHandle = (event: Event) => eventElement(event)?.closest<HTMLElement>(HANDLE_SELECTOR) ?? null;
const resizeKind = (handle: HTMLElement): AppWorkspaceResizeKind | null => {
  const value = handle.dataset.appWorkspaceResize;
  return value === "sidebar" || value === "pane" || value === "detail" || value === "drawer" ? value : null;
};
const resizeDirection = (handle: HTMLElement, kind: AppWorkspaceResizeKind): 1 | -1 =>
  (handle.dataset.workspaceResizeEdge ?? (kind === "sidebar" ? "end" : "start")) === "end" ? 1 : -1;
const workspaceRoot = (handle: HTMLElement) => handle.closest<HTMLElement>(ROOT_SELECTOR);
const workspaceResizable = (root: HTMLElement) => root.dataset.workspaceResizable !== "false";
const rootElements = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => element.closest(ROOT_SELECTOR) === root);
const sidebarElement = (root: HTMLElement) => rootElements(root, ".k2b-app-workspace__sidebar")[0] ?? null;
const mainElement = (root: HTMLElement) => rootElements(root, ".k2b-app-workspace__main")[0] ?? null;
const sidebarCollapsible = (root: HTMLElement) => sidebarElement(root)?.dataset.workspaceCollapsible === "true";
const isVisible = (element: HTMLElement | null): element is HTMLElement =>
  Boolean(element && !element.hidden && getComputedStyle(element).display !== "none");
const elementSize = (element: HTMLElement | null, kind: AppWorkspaceResizeKind) => {
  if (!isVisible(element)) return 0;
  const rect = element.getBoundingClientRect();
  return kind === "drawer" ? rect.height : rect.width;
};
const controlledPanel = (root: HTMLElement, handle: HTMLElement) => {
  const controls = handle.getAttribute("aria-controls");
  if (!controls) return null;
  const panel = document.getElementById(controls);
  return panel?.closest(ROOT_SELECTOR) === root ? panel : null;
};
const controlsResizableRegion = (root: HTMLElement, handle: HTMLElement, kind: AppWorkspaceResizeKind) =>
  (kind === "sidebar" ? sidebarElement(root) : controlledPanel(root, handle))?.dataset.workspaceResizable === "true";
const panelId = (handle: HTMLElement) => safeAppWorkspacePanelId(handle.dataset.workspacePanelId ?? "primary") || "primary";
const numberData = (handle: HTMLElement, key: "workspaceDefaultSize" | "workspaceMinSize" | "workspaceMaxSize", fallback: number) => {
  const value = Number(handle.dataset[key]);
  return Number.isFinite(value) ? value : fallback;
};

const sizeLimits = (root: HTMLElement, handle: HTMLElement, kind: AppWorkspaceResizeKind) => {
  const controlled = controlledPanel(root, handle);
  const main = kind === "pane" ? handle.closest<HTMLElement>(".k2b-app-workspace__main") : mainElement(root);
  const panes = main
    ? Array.from(main.querySelectorAll<HTMLElement>(".k2b-app-workspace__main-pane")).filter(
        (pane) => pane.closest(".k2b-app-workspace__main") === main && !pane.classList.contains("is-primary") && isVisible(pane),
      )
    : [];
  const details = rootElements(root, ".k2b-app-workspace__detail").filter(isVisible);
  const sidebarWidth = elementSize(sidebarElement(root), "sidebar");
  const otherDetailWidth = details.reduce((total, detail) => total + (detail === controlled ? 0 : elementSize(detail, "detail")), 0);
  const defaultMin =
    kind === "sidebar"
      ? APP_WORKSPACE_SIDEBAR_MIN
      : kind === "pane"
        ? APP_WORKSPACE_PANE_MIN
        : kind === "detail"
          ? APP_WORKSPACE_DETAIL_MIN
          : APP_WORKSPACE_DRAWER_MIN;
  const defaultMax =
    kind === "sidebar"
      ? APP_WORKSPACE_SIDEBAR_MAX
      : kind === "pane"
        ? APP_WORKSPACE_PANE_MAX
        : kind === "detail"
          ? APP_WORKSPACE_DETAIL_MAX
          : APP_WORKSPACE_DRAWER_MAX;
  return appWorkspaceResizeLimits({
    kind,
    workspaceSize:
      kind === "drawer"
        ? root.getBoundingClientRect().height
        : kind === "pane" && main
          ? main.getBoundingClientRect().width
          : root.getBoundingClientRect().width,
    reservedSize:
      kind === "sidebar"
        ? otherDetailWidth
        : kind === "pane"
          ? panes.reduce((total, pane) => total + (pane === controlled ? 0 : elementSize(pane, "pane")), 0)
          : kind === "detail"
            ? sidebarWidth + otherDetailWidth
            : 0,
    min: numberData(handle, "workspaceMinSize", defaultMin),
    max: numberData(handle, "workspaceMaxSize", defaultMax),
    sidebarCollapsible: kind === "sidebar" && sidebarCollapsible(root),
  });
};

const currentSize = (root: HTMLElement, handle: HTMLElement, kind: AppWorkspaceResizeKind) =>
  kind === "sidebar" ? elementSize(sidebarElement(root), kind) : elementSize(controlledPanel(root, handle), kind);

const updateHandleValue = (
  root: HTMLElement,
  handle: HTMLElement,
  kind: AppWorkspaceResizeKind,
  size: number,
  limits = sizeLimits(root, handle, kind),
) => {
  const { min, max } = limits;
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  handle.setAttribute("aria-valuenow", String(clamp(size, min, max)));
};

const applySize = (
  root: HTMLElement,
  handle: HTMLElement,
  kind: AppWorkspaceResizeKind,
  requestedSize: number,
  /**
   * `snapSidebar: false` tracks the pointer continuously and only *previews*
   * the collapsed state. Snapping (the default, and what keyboard steps and
   * reconciliation want) quantises the width to either the collapsed rail or
   * the sidebar minimum, which during a live drag makes the handle jump.
   */
  options: { snapSidebar?: boolean } = {},
) => {
  const { min, max } = sizeLimits(root, handle, kind);
  if (kind === "sidebar") {
    const collapsible = sidebarCollapsible(root);
    const sidebar =
      options.snapSidebar === false
        ? { width: clamp(requestedSize, min, max), collapsed: shouldCollapseAppWorkspaceSidebar(requestedSize, collapsible) }
        : resolveAppWorkspaceSidebarWidth(requestedSize, max, collapsible);
    root.style.setProperty("--k2b-workspace-sidebar-width", `${sidebar.width}px`);
    // Cloud removes the attribute rather than writing "false", so that a
    // presence selector (`[data-sidebar-collapsed]`) means "collapsed".
    if (sidebar.collapsed) root.dataset.sidebarCollapsed = "true";
    else delete root.dataset.sidebarCollapsed;
    updateHandleValue(root, handle, kind, sidebar.width, { min, max });
    return sidebar.width;
  }
  const size = clamp(requestedSize, min, max);
  root.style.setProperty(appWorkspacePanelVariable(kind, panelId(handle)), `${size}px`);
  updateHandleValue(root, handle, kind, size, { min, max });
  return size;
};

type PaneFit = {
  desired: number;
  handle: HTMLElement;
  min: number;
};

/**
 * Fits all auxiliary main panes as one group. One main region remains the
 * flexible anchor; the others keep their preferred sizes while space permits
 * and give up the same share of their optional space when the container,
 * navigation or detail panels reduce the available width.
 */
const reconcilePanes = (root: HTMLElement, layoutState: AppWorkspaceLayoutState, active: ActiveResize | null = null) => {
  const main = mainElement(root);
  if (!main || !isVisible(main)) return;
  const handles = rootElements(root, HANDLE_SELECTOR).filter(
    (handle) => resizeKind(handle) === "pane" && controlsResizableRegion(root, handle, "pane"),
  );
  if (!handles.length) return;

  const controlled = new Set(handles.map((handle) => controlledPanel(root, handle)).filter(Boolean));
  const fixedWidth = Array.from(main.querySelectorAll<HTMLElement>(".k2b-app-workspace__main-pane"))
    .filter(
      (pane) =>
        pane.closest(".k2b-app-workspace__main") === main &&
        !pane.classList.contains("is-primary") &&
        isVisible(pane) &&
        !controlled.has(pane),
    )
    .reduce((total, pane) => total + elementSize(pane, "pane"), 0);
  const fits: PaneFit[] = handles.flatMap((handle) => {
    const panel = controlledPanel(root, handle);
    if (!isVisible(panel)) return [];
    const min = numberData(handle, "workspaceMinSize", APP_WORKSPACE_PANE_MIN);
    const max = Math.max(min, numberData(handle, "workspaceMaxSize", APP_WORKSPACE_PANE_MAX));
    const preferred =
      active?.moved && active.root === root && active.kind === "pane" && active.handle === handle
        ? active.liveSize
        : (layoutState.paneWidths?.[panelId(handle)] ?? numberData(handle, "workspaceDefaultSize", elementSize(panel, "pane")));
    const desired = clamp(preferred, min, max);
    return [{ desired, handle, min }];
  });
  if (!fits.length) return;

  const sizes = fitAppWorkspacePaneSizes(fits, main.getBoundingClientRect().width - fixedWidth - APP_WORKSPACE_MAIN_MIN);
  fits.forEach((fit, index) => {
    root.style.setProperty(appWorkspacePanelVariable("pane", panelId(fit.handle)), `${sizes[index]}px`);
  });
  fits.forEach((fit, index) => updateHandleValue(root, fit.handle, "pane", sizes[index]!));
};

/**
 * Marquee support for a truncated sidebar label.
 *
 * The animation needs to know how far to travel, and that is only knowable
 * once the label has been laid out — so it is measured lazily, on the same
 * hover/focus that triggers it, and published as a custom property. Labels
 * that fit get no `data-overflow`, so they never animate.
 */
const measureLabel = (label: HTMLElement) => {
  const text = label.querySelector<HTMLElement>(LABEL_TEXT_SELECTOR);
  if (!text) return;
  const overflow = Math.max(0, text.scrollWidth - label.clientWidth);
  label.style.setProperty("--k2b-sidebar-label-overflow", `${overflow}px`);
  if (overflow > 2) label.dataset.overflow = "true";
  else delete label.dataset.overflow;
};

export const installAppWorkspaceController = (options: AppWorkspaceControllerOptions = {}): (() => void) => {
  const eventRoot = options.root ?? document;
  const stopScrollFades = installScrollFades(eventRoot);
  let layoutState = normalizeAppWorkspaceLayoutState(options.readState?.()) ?? { version: 2 as const };
  let active: ActiveResize | null = null;
  let resizeFrame: number | null = null;
  let pendingClient: number | null = null;

  const persistSize = (handle: HTMLElement, kind: AppWorkspaceResizeKind, size: number) => {
    if (kind === "sidebar") {
      const collapsed = size === APP_WORKSPACE_SIDEBAR_COLLAPSED;
      layoutState = {
        ...layoutState,
        sidebarWidth: collapsed ? layoutState.sidebarWidth : size,
        sidebarCollapsed: collapsed,
      };
    } else {
      const key = kind === "pane" ? "paneWidths" : kind === "detail" ? "detailWidths" : "drawerHeights";
      layoutState = { ...layoutState, [key]: { ...layoutState[key], [panelId(handle)]: size } };
    }
    options.writeState?.(layoutState);
  };

  const flushPointerMove = () => {
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
    if (!active || pendingClient === null) return;
    const client = pendingClient;
    pendingClient = null;
    active.moved ||= client !== active.startClient;
    active.liveSize = applySize(
      active.root,
      active.handle,
      active.kind,
      active.startSize + (client - active.startClient) * active.direction,
      { snapSidebar: active.kind !== "sidebar" },
    );
    if (active.kind === "sidebar" || active.kind === "detail") reconcilePanes(active.root, layoutState, active);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    pendingClient = active.kind === "drawer" ? event.clientY : event.clientX;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(flushPointerMove);
  };
  const stopResize = (event?: Event) => {
    if (!active || (event instanceof PointerEvent && event.pointerId !== active.pointerId)) return;
    flushPointerMove();
    const finished = active;
    active = null;
    delete finished.root.dataset.workspaceResizeActive;
    delete finished.handle.dataset.workspaceResizeActive;
    if (finished.moved) {
      // A pane's rendered width may have been fitted below the pointer's live
      // preference to keep the main region usable. Persist that preference,
      // then fit the visible panes from the updated state. Reapplying it through
      // the per-handle limits here would count the already-fitted sibling panes
      // a second time and permanently shrink the preference on release.
      const size =
        finished.kind === "pane" ? finished.liveSize : applySize(finished.root, finished.handle, finished.kind, finished.liveSize);
      persistSize(finished.handle, finished.kind, size);
      if (finished.kind !== "drawer") reconcilePanes(finished.root, layoutState);
    }
    if (finished.handle.hasPointerCapture?.(finished.pointerId)) finished.handle.releasePointerCapture(finished.pointerId);
    document.body.style.userSelect = finished.previousUserSelect;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    window.removeEventListener("blur", stopResize);
  };
  const onPointerDown = (event: PointerEvent) => {
    const handle = resizeHandle(event);
    const kind = handle ? resizeKind(handle) : null;
    const root = handle ? workspaceRoot(handle) : null;
    if (!handle || !kind || !root || !workspaceResizable(root) || !controlsResizableRegion(root, handle, kind) || event.button !== 0)
      return;
    event.preventDefault();
    stopResize();
    pendingClient = null;
    const startSize = currentSize(root, handle, kind);
    active = {
      handle,
      root,
      kind,
      pointerId: event.pointerId,
      startClient: kind === "drawer" ? event.clientY : event.clientX,
      startSize,
      liveSize: startSize,
      moved: false,
      direction: resizeDirection(handle, kind),
      previousUserSelect: document.body.style.userSelect,
    };
    root.dataset.workspaceResizeActive = kind;
    handle.dataset.workspaceResizeActive = "true";
    document.body.style.userSelect = "none";
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("blur", stopResize);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const handle = resizeHandle(event);
    const kind = handle ? resizeKind(handle) : null;
    const root = handle ? workspaceRoot(handle) : null;
    if (!handle || !kind || !root || !workspaceResizable(root) || !controlsResizableRegion(root, handle, kind)) return;
    const current = currentSize(root, handle, kind);
    const { min, max } = sizeLimits(root, handle, kind);
    const step = event.shiftKey ? 32 : 8;
    let requested: number | null = null;
    const direction = resizeDirection(handle, kind);
    const collapsibleSidebar = kind === "sidebar" && sidebarCollapsible(root);
    if (event.key === "Home") requested = min;
    else if (event.key === "End") requested = max;
    // The drawer arrows follow the handle's edge like every other kind; the
    // hard-coded +/- here inverted for a handle on the `end` edge.
    else if (kind === "drawer" && event.key === "ArrowUp") requested = current - step * direction;
    else if (kind === "drawer" && event.key === "ArrowDown") requested = current + step * direction;
    // A collapsible sidebar is already at its minimum when the rail is the
    // next step: without these two branches a keyboard step of 8 (or 32) is
    // clamped straight back to the minimum, so the handle is simply stuck and
    // collapse/expand is unreachable without a pointer.
    else if (kind !== "drawer" && event.key === "ArrowLeft")
      requested = collapsibleSidebar && current <= APP_WORKSPACE_SIDEBAR_MIN ? APP_WORKSPACE_SIDEBAR_COLLAPSED : current - step * direction;
    else if (kind !== "drawer" && event.key === "ArrowRight")
      requested =
        collapsibleSidebar && current <= APP_WORKSPACE_SIDEBAR_COLLAPSED
          ? (layoutState.sidebarWidth ?? APP_WORKSPACE_SIDEBAR_MIN)
          : current + step * direction;
    if (requested === null) return;
    event.preventDefault();
    persistSize(handle, kind, applySize(root, handle, kind, requested));
    if (kind === "sidebar" || kind === "detail") reconcilePanes(root, layoutState);
  };

  const allRoots = () => {
    const nested = Array.from(eventRoot.querySelectorAll<HTMLElement>(ROOT_SELECTOR));
    return eventRoot instanceof HTMLElement && eventRoot.matches(ROOT_SELECTOR) ? [eventRoot, ...nested] : nested;
  };
  const roots = () => {
    // A hidden or zero-width workspace measures 0, which drives every limit
    // down to its minimum — reconciling one would overwrite its variables and
    // `aria-valuenow` with that minimum for good.
    return allRoots().filter((root) => getComputedStyle(root).display !== "none" && root.getBoundingClientRect().width > 0);
  };
  const reconcile = () => {
    roots().forEach((root) => {
      // `data-workspace-resizable="false"` already refuses pointer and keyboard
      // resizing; without this the same workspace still had persisted sizes
      // forced onto it on load and on every window resize.
      if (!workspaceResizable(root)) return;
      const handles = rootElements(root, HANDLE_SELECTOR);
      // Chrome establishes the space available to the work area. Auxiliary
      // panes are then fitted together into what remains, so DOM order cannot
      // give the last pane an accidental sizing priority.
      handles
        .filter((handle) => resizeKind(handle) !== "pane")
        .forEach((handle) => {
          const kind = resizeKind(handle);
          if (!kind || !controlsResizableRegion(root, handle, kind)) return;
          if (active?.moved && active.root === root && active.handle === handle && active.kind === kind) {
            applySize(root, handle, kind, active.liveSize, { snapSidebar: kind !== "sidebar" });
            return;
          }
          const persisted =
            kind === "sidebar"
              ? layoutState.sidebarCollapsed && sidebarCollapsible(root)
                ? APP_WORKSPACE_SIDEBAR_COLLAPSED
                : layoutState.sidebarWidth
              : kind === "detail"
                ? layoutState.detailWidths?.[panelId(handle)]
                : layoutState.drawerHeights?.[panelId(handle)];
          if (persisted !== undefined) applySize(root, handle, kind, persisted);
          else updateHandleValue(root, handle, kind, currentSize(root, handle, kind));
        });
      reconcilePanes(root, layoutState, active?.root === root ? active : null);
    });
  };
  /**
   * A handle's limits move whenever anything around it does — opening a detail
   * panel, showing a pane. Only `applySize` refreshed them, so a keyboard user
   * arriving at a handle was announced whatever `aria-valuenow`/`valuemax` the
   * last drag left behind.
   */
  const onFocusIn = (event: FocusEvent) => {
    const handle = resizeHandle(event);
    const kind = handle ? resizeKind(handle) : null;
    const root = handle ? workspaceRoot(handle) : null;
    if (handle && kind && root && controlsResizableRegion(root, handle, kind)) {
      updateHandleValue(root, handle, kind, currentSize(root, handle, kind));
    }
    const label = eventElement(event)?.closest<HTMLElement>(ITEM_SELECTOR)?.querySelector<HTMLElement>(LABEL_SELECTOR);
    if (label) requestAnimationFrame(() => measureLabel(label));
  };

  // Measured on entry rather than on every render: `scrollWidth` forces layout,
  // and a sidebar can hold hundreds of rows.
  const onPointerOver = (event: PointerEvent) => {
    const label = eventElement(event)?.closest<HTMLElement>(LABEL_SELECTOR);
    if (!label || (event.relatedTarget instanceof Node && label.contains(event.relatedTarget))) return;
    requestAnimationFrame(() => measureLabel(label));
  };

  // A resize changes every label's available width, so the cached measurement
  // is dropped and taken again on the next hover or focus.
  const clearMeasuredLabels = () => {
    eventRoot.querySelectorAll<HTMLElement>(LABEL_SELECTOR).forEach((label) => {
      delete label.dataset.overflow;
      label.style.removeProperty("--k2b-sidebar-label-overflow");
    });
  };

  // Geometry can change without a window resize: a parent can resize the
  // workspace, or a detail/pane can open. All sources share one frame so a
  // transition performs at most one layout reconciliation.
  let reconcileFrame: number | null = null;
  const scheduleReconcile = (clearLabels = false) => {
    if (clearLabels) clearMeasuredLabels();
    if (reconcileFrame !== null) return;
    reconcileFrame = requestAnimationFrame(() => {
      reconcileFrame = null;
      reconcile();
    });
  };
  const onResize = () => scheduleReconcile(true);

  const observedRoots = new Set<HTMLElement>();
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          scheduleReconcile(true);
        });
  const syncObservedRoots = () => {
    if (!resizeObserver) return;
    const next = new Set(allRoots());
    observedRoots.forEach((root) => {
      if (!next.has(root)) {
        resizeObserver.unobserve(root);
        observedRoots.delete(root);
      }
    });
    next.forEach((root) => {
      if (observedRoots.has(root)) return;
      observedRoots.add(root);
      resizeObserver.observe(root);
    });
  };
  const layoutNode = (node: Node) =>
    node instanceof Element && (node.matches(LAYOUT_REGION_SELECTOR) || Boolean(node.querySelector(LAYOUT_REGION_SELECTOR)));
  const mutationObserver =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const changed = records.some((record) =>
            record.type === "attributes"
              ? record.target instanceof Element && record.target.matches(LAYOUT_REGION_SELECTOR)
              : [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(layoutNode),
          );
          if (!changed) return;
          syncObservedRoots();
          scheduleReconcile();
        });

  eventRoot.addEventListener("pointerdown", onPointerDown as EventListener);
  eventRoot.addEventListener("keydown", onKeyDown as EventListener);
  eventRoot.addEventListener("focusin", onFocusIn as EventListener);
  eventRoot.addEventListener("pointerover", onPointerOver as EventListener);
  window.addEventListener("resize", onResize);
  syncObservedRoots();
  mutationObserver?.observe(eventRoot, {
    attributes: true,
    attributeFilter: ["hidden"],
    childList: true,
    subtree: true,
  });
  scheduleReconcile();
  return () => {
    stopScrollFades();
    // Flush the latest coalesced pointer sample before listeners and frames are
    // torn down, so unmounting during a drag cannot lose the final size.
    stopResize();
    if (reconcileFrame !== null) cancelAnimationFrame(reconcileFrame);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    observedRoots.clear();
    eventRoot.removeEventListener("pointerdown", onPointerDown as EventListener);
    eventRoot.removeEventListener("keydown", onKeyDown as EventListener);
    eventRoot.removeEventListener("focusin", onFocusIn as EventListener);
    eventRoot.removeEventListener("pointerover", onPointerOver as EventListener);
    window.removeEventListener("resize", onResize);
  };
};
