import { suppressTextSelection } from "../internal/text-selection";
import { prefersReducedMotion } from "../motion";
import {
  APP_WORKSPACE_DETAIL_DEFAULT,
  APP_WORKSPACE_DETAIL_MAX,
  APP_WORKSPACE_DETAIL_MIN,
  APP_WORKSPACE_DRAWER_MAX,
  APP_WORKSPACE_DRAWER_MIN,
  APP_WORKSPACE_MAIN_MIN,
  APP_WORKSPACE_PANE_DEFAULT,
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
import { readAppWorkspaceWidth, resolveAppWorkspaceWidth } from "./app-workspace-width";
import { installScrollFades } from "./scroll-fade";

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
  /** A hideable sidebar dragged below half its minimum previews the hidden state. */
  hiding: boolean;
  direction: 1 | -1;
  releaseTextSelection: () => void;
};

const HANDLE_SELECTOR = "[data-app-workspace-resize]";
const ROOT_SELECTOR = "[data-k2b-app-workspace]";
const LAYOUT_REGION_SELECTOR = [
  ROOT_SELECTOR,
  ".k2b-app-workspace__sidebar",
  ".k2b-app-workspace__main",
  ".k2b-app-workspace__main-pane",
  ".k2b-app-workspace__detail",
  ".k2b-app-workspace__drawer",
  HANDLE_SELECTOR,
].join(",");
const TOGGLE_SELECTOR = "[data-app-workspace-sidebar-toggle]";
const DETAIL_TOGGLE_SELECTOR = "[data-app-workspace-detail-toggle]";
const DETAIL_DRAWER_SELECTOR = '.k2b-app-workspace__detail[data-workspace-detail-drawer="open"]';
const cssState = (element: HTMLElement, name: string) => getComputedStyle(element).getPropertyValue(name).trim();
const detailWaiting = (aside: HTMLElement) => cssState(aside, "--k2b-workspace-detail-waiting") === "1";
const detailDrawer = (aside: HTMLElement) => aside.dataset.workspaceDetailDrawer === "open";
const detailToggle = (aside: HTMLElement) => {
  const root = workspaceRoot(aside);
  return rootElements(root ?? aside, DETAIL_TOGGLE_SELECTOR).find((toggle) => toggle.getAttribute("aria-controls") === aside.id);
};
// The trail's registered property accepts a length, not the drawer's percentage
// cap. Only a user-opened drawer needs this measurement; the first frame stays CSS-owned.
const detailDrawerContent = (aside: HTMLElement) => aside.closest<HTMLElement>(".k2b-app-workspace__content");
const syncDetailDrawerSpace = (aside: HTMLElement) =>
  detailDrawerContent(aside)?.style.setProperty("--k2b-detail-space", `${aside.getBoundingClientRect().width}px`);
const parkDetailDrawer = (aside: HTMLElement, focus = false) => {
  if (!detailDrawer(aside)) return;
  delete aside.dataset.workspaceDetailDrawer;
  detailDrawerContent(aside)?.style.removeProperty("--k2b-detail-space");
  const toggle = detailToggle(aside);
  toggle?.setAttribute("aria-expanded", "false");
  if (focus) toggle?.focus({ preventScroll: true });
};

/** Parks open waiting-detail drawers; focus follows only when it was inside one. */
export const parkWorkspaceDetailDrawers = (root: ParentNode = document): void => {
  for (const aside of root.querySelectorAll<HTMLElement>(DETAIL_DRAWER_SELECTOR))
    parkDetailDrawer(aside, aside.contains(aside.ownerDocument.activeElement));
};
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
/** Text entry, menus, dialogs, and open popups keep their own keys. */
const KEY_OWNER_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox'], [role='spinbutton'], [role='menu'], [role='listbox'], [role='dialog'], dialog, [aria-haspopup]:not([aria-haspopup='false'])[aria-expanded='true']";
const ITEM_SELECTOR = ".k2b-app-workspace__sidebar-item";
/** Controls inside a selected row that act on their own instead of choosing the row. */
const NESTED_CONTROL_SELECTOR =
  "[aria-expanded], [aria-haspopup]:not([aria-haspopup='false']), [aria-pressed], [role='checkbox'], [role='switch'], [role='menuitem'], input, select, textarea, summary";
const DETAIL_REQUEST_CONTROL_SELECTOR = "[aria-pressed], [aria-expanded], [aria-controls]";
const SELECTION_MARK_SELECTOR =
  '[aria-selected="true"], [aria-current]:not([aria-current="false"]):not([aria-current="date"]):not([aria-current="time"]), [data-selected="true"]';
// Calendar day marks select a date range, not the Detail's subject.
const IGNORED_SELECTION_MARK_SELECTOR = "[data-calendar-day-key]";
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
const sidebarForm = (root: HTMLElement) => cssState(sidebarElement(root) ?? root, "--k2b-workspace-sidebar-form");
const mainElement = (root: HTMLElement) => rootElements(root, ".k2b-app-workspace__main")[0] ?? null;
const sidebarCollapsible = (root: HTMLElement) => sidebarElement(root)?.dataset.workspaceCollapsible === "true";
const sidebarHideable = (root: HTMLElement) => sidebarElement(root)?.dataset.workspaceHideable === "true";
/**
 * Asks the owning `AppWorkspace.Sidebar` to hide. The sidebar's `hidden` prop
 * stays application state, so the controller only requests the change.
 */
export const APP_WORKSPACE_SIDEBAR_HIDE_EVENT = "k2b-app-workspace-sidebar-hide";
/** Asks the owning `AppWorkspace.Detail` to close; its `onClose` decides. */
export const APP_WORKSPACE_DETAIL_CLOSE_EVENT = "k2b-app-workspace-detail-close";
/**
 * Asks the owning Detail to step by `detail.direction` (`-1` or `1`). It writes
 * the Main element showing the selection to `detail.item`, read synchronously
 * by the controller after dispatch.
 */
export const APP_WORKSPACE_DETAIL_STEP_EVENT = "k2b-app-workspace-detail-step";
export type AppWorkspaceDetailStep = { direction: 1 | -1; item?: HTMLElement };
const previewSidebarHidden = (root: HTMLElement, hidden: boolean) => {
  const sidebar = sidebarElement(root);
  if (!sidebar) return;
  if (hidden) sidebar.dataset.workspaceHidePreview = "true";
  else delete sidebar.dataset.workspaceHidePreview;
};
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
const flexibleLevel = (pane: HTMLElement) => {
  if (!pane.hasAttribute("data-workspace-level")) return false;
  const root = workspaceRoot(pane);
  const widthClass = root ? cssState(root, "--k2b-workspace-level-class") : "";
  return Boolean(widthClass && pane.dataset.workspaceLevelLast?.split(" ").includes(widthClass));
};
const levelsMain = (handle: HTMLElement) => handle.closest(".k2b-app-workspace__main")?.hasAttribute("data-workspace-levels") ?? false;
const controlsResizableRegion = (root: HTMLElement, handle: HTMLElement, kind: AppWorkspaceResizeKind) => {
  const panel = kind === "sidebar" ? sidebarElement(root) : controlledPanel(root, handle);
  return (
    panel?.dataset.workspaceResizable === "true" &&
    (!panel.hasAttribute("data-workspace-level") || (isVisible(panel) && isVisible(handle) && !flexibleLevel(panel)))
  );
};
const panelId = (handle: HTMLElement) => safeAppWorkspacePanelId(handle.dataset.workspacePanelId ?? "primary") || "primary";
const numberData = (handle: HTMLElement, key: "workspaceDefaultSize" | "workspaceMinSize" | "workspaceMaxSize", fallback: number) => {
  const value = Number(handle.dataset[key]);
  return Number.isFinite(value) ? value : fallback;
};

const sizeLimits = (root: HTMLElement, handle: HTMLElement, kind: AppWorkspaceResizeKind, reserveMainMinimum = true) => {
  const controlled = controlledPanel(root, handle);
  const main = kind === "pane" ? handle.closest<HTMLElement>(".k2b-app-workspace__main") : mainElement(root);
  const panes = main
    ? Array.from(main.querySelectorAll<HTMLElement>(".k2b-app-workspace__main-pane")).filter(
        (pane) =>
          pane.closest(".k2b-app-workspace__main") === main &&
          !pane.classList.contains("is-primary") &&
          !flexibleLevel(pane) &&
          isVisible(pane),
      )
    : [];
  const separatorSize =
    kind === "pane" && main
      ? Array.from(main.querySelectorAll<HTMLElement>(`.k2b-app-workspace__resize${HANDLE_SELECTOR}`))
          .filter(
            (separator) =>
              separator.closest(".k2b-app-workspace__main") === main && resizeKind(separator) === "pane" && isVisible(separator),
          )
          .reduce((total, separator) => {
            const style = getComputedStyle(separator);
            return (
              total +
              Math.max(
                0,
                separator.getBoundingClientRect().width +
                  (Number.parseFloat(style.marginLeft) || 0) +
                  (Number.parseFloat(style.marginRight) || 0),
              )
            );
          }, 0)
      : 0;
  // Content ends before the detail track, so its width alone would shrink a
  // persisted panel again on every reconciliation. Measure from Content's
  // start to the workspace's inner end: this includes the detail column and
  // leaves out a desktop sidebar, while an overlay sidebar takes no width.
  const content = kind === "detail" ? controlled?.closest<HTMLElement>(".k2b-app-workspace__content") : null;
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
  const mainSpec = readAppWorkspaceWidth(mainElement(root)?.dataset.workspaceMainMin);
  const mainMinValue = cssState(root, "--k2b-workspace-main-min");
  const mainMin =
    typeof mainSpec === "object"
      ? resolveAppWorkspaceWidth(mainSpec, root.getBoundingClientRect().width)
      : mainMinValue.endsWith("px")
        ? Number.parseFloat(mainMinValue)
        : APP_WORKSPACE_MAIN_MIN;
  const mainExtra = Math.max(0, (Number.isFinite(mainMin) ? mainMin : APP_WORKSPACE_MAIN_MIN) - APP_WORKSPACE_MAIN_MIN);
  const limits = appWorkspaceResizeLimits({
    kind,
    workspaceSize:
      kind === "drawer"
        ? root.getBoundingClientRect().height
        : kind === "pane" && main
          ? main.getBoundingClientRect().width
          : content
            ? root.getBoundingClientRect().right - root.clientLeft - content.getBoundingClientRect().left
            : kind === "sidebar"
              ? root.getBoundingClientRect().width - 2 * root.clientLeft
              : root.getBoundingClientRect().width,
    // Interactive sizing keeps Main's declared minimum beside the sidebar and the Detail.
    reservedSize:
      kind === "sidebar" && reserveMainMinimum
        ? mainExtra
        : kind === "detail"
          ? 8 + (reserveMainMinimum ? mainExtra : 0)
          : kind === "pane"
            ? panes.reduce((total, pane) => total + (pane === controlled ? 0 : elementSize(pane, "pane")), 0) + separatorSize
            : 0,
    min: numberData(handle, "workspaceMinSize", defaultMin),
    max: numberData(handle, "workspaceMaxSize", defaultMax),
    sidebarCollapsible: kind === "sidebar" && sidebarCollapsible(root),
  });
  // Widths are applied as whole pixels; rounding up must not cross the fit boundary.
  return kind === "sidebar" ? { min: limits.min, max: Math.max(limits.min, Math.floor(limits.max)) } : limits;
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

const applyRegionSize = (
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
  options: { snapSidebar?: boolean; reserveMainMinimum?: boolean } = {},
) => {
  const { min, max } = sizeLimits(root, handle, kind, options.reserveMainMinimum);
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
    // A restored width may require an overlay; the handle still advertises interactive limits.
    updateHandleValue(root, handle, kind, sidebar.width);
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
  cssDefault: boolean;
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

  if (main.hasAttribute("data-workspace-levels")) {
    // CSS owns the multi-level fit, including a flexible shown-last pane.
    // Keep preferences intact when the window temporarily has less room.
    for (const handle of handles) {
      const min = numberData(handle, "workspaceMinSize", APP_WORKSPACE_PANE_MIN);
      const max = Math.max(min, numberData(handle, "workspaceMaxSize", APP_WORKSPACE_PANE_MAX));
      const preferred = active?.moved && active.handle === handle ? active.liveSize : layoutState.paneWidths?.[panelId(handle)];
      if (preferred !== undefined)
        root.style.setProperty(appWorkspacePanelVariable("pane", panelId(handle)), `${clamp(preferred, min, max)}px`);
      updateHandleValue(root, handle, "pane", currentSize(root, handle, "pane"));
    }
    return;
  }

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
    const spec = readAppWorkspaceWidth(handle.dataset.workspaceDefaultSize) ?? elementSize(panel, "pane");
    const preferred =
      active?.moved && active.root === root && active.kind === "pane" && active.handle === handle
        ? active.liveSize
        : layoutState.paneWidths?.[panelId(handle)];
    const cssDefault = preferred === undefined && typeof spec !== "number";
    if (cssDefault && root.style.getPropertyValue(appWorkspacePanelVariable("pane", panelId(handle))))
      // Drop a previous live width (or an inherited SSR preference after reset).
      root.style.setProperty(appWorkspacePanelVariable("pane", panelId(handle)), "initial");
    // CSS has already applied this default and the pane-fit clamp, including
    // subpixels. Reserve exactly that box when fitting other preferences;
    // measuring must not turn a responsive default into a stored px width.
    const requested = preferred ?? resolveAppWorkspaceWidth(spec, root.getBoundingClientRect().width);
    const desired = cssDefault ? elementSize(panel, "pane") : clamp(requested, min, max);
    return [{ desired, handle, min: cssDefault ? desired : min, cssDefault }];
  });
  if (!fits.length) return;

  const sizes = fitAppWorkspacePaneSizes(fits, main.getBoundingClientRect().width - fixedWidth - APP_WORKSPACE_MAIN_MIN);
  fits.forEach((fit, index) => {
    // Defaults stay CSS-owned; fit only saved or live preferences around them.
    if (!fit.cssDefault) root.style.setProperty(appWorkspacePanelVariable("pane", panelId(fit.handle)), `${sizes[index]}px`);
  });
  fits.forEach((fit, index) => updateHandleValue(root, fit.handle, "pane", sizes[index]!));
};

type OverlaySidebar = { root: HTMLElement; sidebar: HTMLElement; toggle: HTMLElement };
/** An open overlay remembers the regions it made inert, so it leaves the application's own `inert` alone. */
type OpenOverlay = OverlaySidebar & { inerted: HTMLElement[] };

/**
 * The elements Tab stops at, in order. A roving tab index, as in a tree, keeps
 * links and buttons at `tabindex="-1"`; they take focus but are no stops.
 */
const tabStopsIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      element.getClientRects().length > 0 &&
      !element.closest("[inert]") &&
      getComputedStyle(element).visibility !== "hidden",
  );
/** Several controllers can see one click on a nested workspace's button; the innermost one, which sees it first, owns it. */
const claimedToggleClicks = new WeakSet<Event>();
const claimedDetailGestures = new WeakSet<Event>();

/**
 * The overlay sidebar opens over the work area when its column does not fit
 * from the button in the workspace's head. While it is open the rest of
 * the workspace is inert, Tab stays in the sidebar, and Escape, the scrim,
 * choosing an item, hiding the sidebar, or leaving the width range close it
 * again. The state is one attribute on the workspace root, so server-rendered
 * and hydrated workspaces behave the same.
 */
const overlayTarget = (toggle: HTMLElement): OverlaySidebar | null => {
  const root = workspaceRoot(toggle);
  // The button belongs to its workspace's own sidebar. A sidebar rendered apart
  // from the head, for example in an island, can carry another id than the one
  // the head named, so the button learns the real one here.
  const sidebar = root ? sidebarElement(root) : null;
  if (!root || !sidebar || sidebar.hidden || sidebar.dataset.mobile === "stacked") return null;
  if (sidebar.id) toggle.setAttribute("aria-controls", sidebar.id);
  return { root, sidebar, toggle };
};
const overlayRegions = (root: HTMLElement, sidebar: HTMLElement) =>
  Array.from(root.children)
    .flatMap((child) =>
      child instanceof HTMLElement && (child.localName === "solid-island" || child.localName === "solid-client")
        ? Array.from(child.children)
        : [child],
    )
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== sidebar && !child.contains(sidebar));

export const installAppWorkspaceController = (options: AppWorkspaceControllerOptions = {}): (() => void) => {
  const eventRoot = options.root ?? document;
  // A document has no owner document; an element root listens on its own.
  const ownerDocument = eventRoot.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  let overlay: OpenOverlay | null = null;
  // A server-rendered head names the sidebar before the sidebar renders; the button learns its real id now.
  for (const toggle of eventRoot.querySelectorAll<HTMLElement>(TOGGLE_SELECTOR)) overlayTarget(toggle);
  const openOverlay = (target: OverlaySidebar) => {
    if (overlay) closeOverlay("none");
    const inerted = overlayRegions(target.root, target.sidebar).filter((region) => !region.hasAttribute("inert"));
    overlay = { ...target, inerted };
    target.root.dataset.sidebarOverlay = "open";
    target.toggle.setAttribute("aria-expanded", "true");
    inerted.forEach((region) => region.setAttribute("inert", ""));
    // Focus starts on the current destination, so the reader knows where they
    // are: on its own tab stop, or on the tree item around it.
    const current = target.sidebar.querySelector<HTMLElement>("[aria-current='page'], .is-active");
    const stops = tabStopsIn(target.sidebar);
    const first =
      (current && (stops.find((element) => current.contains(element)) ?? stops.findLast((element) => element.contains(current)))) ??
      stops[0];
    if (first) first.focus();
    else {
      target.sidebar.tabIndex = -1;
      target.sidebar.focus();
    }
  };
  /**
   * `"button"` returns focus to the button. `"kept"` leaves it where it moved,
   * for example into a dialog an item opened, and only rescues focus that the
   * closing sidebar would hide. `"none"` moves nothing, for cleanup.
   */
  const closeOverlay = (focus: "button" | "kept" | "none") => {
    const closing = overlay;
    if (!closing) return;
    overlay = null;
    delete closing.root.dataset.sidebarOverlay;
    closing.toggle.setAttribute("aria-expanded", "false");
    closing.inerted.forEach((region) => region.removeAttribute("inert"));
    if (focus === "none") return;
    const active = document.activeElement;
    if (focus === "button" || !active || active === document.body || closing.sidebar.contains(active)) closing.toggle.focus();
  };
  const onClick = (event: MouseEvent) => {
    const target = eventElement(event);
    const detailButton = target?.closest<HTMLElement>(DETAIL_TOGGLE_SELECTOR);
    if (detailButton) {
      const root = workspaceRoot(detailButton);
      const aside = root ? controlledPanel(root, detailButton) : null;
      if (!aside || aside.hidden || !detailWaiting(aside) || claimedToggleClicks.has(event)) return;
      claimedToggleClicks.add(event);
      if (detailDrawer(aside)) parkDetailDrawer(aside);
      else {
        openDetailDrawer(aside);
        if (event.detail === 0) requestTitle(aside);
        else detailButton.focus({ preventScroll: true });
      }
      syncDetailRequestControls();
      return;
    }
    const toggle = target?.closest<HTMLElement>(TOGGLE_SELECTOR);
    if (toggle) {
      const next = overlayTarget(toggle);
      if (!next || claimedToggleClicks.has(event)) return;
      claimedToggleClicks.add(event);
      if (overlay?.sidebar === next.sidebar) closeOverlay("button");
      else if (sidebarForm(next.root) === "overlay") openOverlay(next);
      return;
    }
    if (!overlay || !target) return;
    // The scrim is the workspace root's own pseudo-element.
    if (target === overlay.root) {
      closeOverlay("button");
      return;
    }
    // Choosing a destination closes the overlay: a link, or the button of a
    // row. A tree folder that only expands, a control that opens a popup or
    // expands something, such as a row's preview, and an item's own actions
    // keep it open.
    const control = target.closest<HTMLElement>("a[href], button");
    if (!control || !overlay.sidebar.contains(control)) return;
    if (
      target.closest("[data-k2b-nav-tree-toggle]") ||
      control.closest(
        "[data-k2b-nav-tree-disclosure], .k2b-app-workspace__sidebar-item-action, .k2b-app-workspace__sidebar-item-actions",
      ) ||
      control.matches("[aria-haspopup], [aria-expanded]")
    )
      return;
    if (control.matches("a[href]") || control.closest(ITEM_SELECTOR)) closeOverlay("kept");
  };
  const onOverlayKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = eventElement(event);
    if (!target) return;
    // Escape also closes it when a click left focus on nothing, so on the body.
    if (overlay && event.key === "Escape" && (overlay.sidebar.contains(target) || target === ownerDocument.body)) {
      event.preventDefault();
      closeOverlay("button");
      return;
    }
    const aside = target.closest<HTMLElement>(detailSelector);
    const panel =
      overlay?.sidebar ?? (phone?.matches && aside && !aside.hidden && phonePage(aside) && eventRoot.contains(aside) ? aside : null);
    if (event.key !== "Tab") return;
    if (!panel) {
      // Focus outside an open phone page, on the body after a load or on chrome the page covers, enters the page.
      // Dialogs and popovers keep their own Tab order.
      const page = phone?.matches ? allRoots().flatMap(openDetails).find(phonePage) : undefined;
      if (!page || ownerDocument.querySelector("dialog[open], [aria-modal='true']") || target.closest("[popover]")) return;
      if (target !== ownerDocument.body) {
        const rect = target.getBoundingClientRect();
        const hit = ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (hit && target.contains(hit)) return;
      }
      const stops = tabStopsIn(page);
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
      return;
    }
    if (!panel.contains(target)) return;
    const stops = tabStopsIn(panel);
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    // Focus can also rest on an element that is no tab stop, such as a title focused as the panel opened.
    const active = document.activeElement;
    const before = (element: Element | null, other: Element | null) =>
      Boolean(element && other && element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (event.shiftKey && !stops.some((stop) => before(stop, active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && !stops.some((stop) => before(active, stop))) {
      event.preventDefault();
      first.focus();
    }
  };
  // Whether each open detail waited at the last check, so a column that starts
  // waiting under focus hands that focus to its Details button.
  const detailWasWaiting = new WeakMap<HTMLElement, boolean>();
  const detailRequestExpanded = new Map<HTMLElement, { rendered: string | null; written: string }>();
  const restoreDetailRequestExpanded = (control: HTMLElement, state: { rendered: string | null; written: string }) => {
    // A newer application render already owns the current value.
    if (control.getAttribute("aria-expanded") !== state.written) return;
    if (state.rendered === null) control.removeAttribute("aria-expanded");
    else control.setAttribute("aria-expanded", state.rendered);
  };
  const requestedWaitingDetail = (control: HTMLElement) => {
    if (!wide?.matches || control.matches(DETAIL_TOGGLE_SELECTOR) || !eventRoot.contains(control)) return null;
    const root = workspaceRoot(control);
    const region = control.closest(".k2b-app-workspace__main, .k2b-app-workspace__detail");
    if (!root || !region || region.closest(ROOT_SELECTOR) !== root) return null;
    const ids = control.getAttribute("aria-controls")?.split(/\s+/);
    return rootElements(root, detailSelector).find((aside) => !aside.hidden && ids?.includes(aside.id) && detailWaiting(aside)) ?? null;
  };
  const syncDetailRequestControls = () => {
    const waitingControls = new Map<HTMLElement, HTMLElement>();
    for (const root of allRoots()) {
      // Only a control that names a Detail can request it.
      for (const control of rootElements(root, "[aria-controls]")) {
        const aside = requestedWaitingDetail(control);
        if (aside) waitingControls.set(control, aside);
      }
    }
    detailRequestExpanded.forEach((state, control) => {
      if (waitingControls.has(control)) return;
      restoreDetailRequestExpanded(control, state);
      detailRequestExpanded.delete(control);
    });
    waitingControls.forEach((aside, control) => {
      const current = control.getAttribute("aria-expanded");
      const state = detailRequestExpanded.get(control);
      const written = String(detailDrawer(aside));
      // Keep the application's latest value to restore when waiting ends.
      const rendered = !state || current !== state.written ? current : state.rendered;
      detailRequestExpanded.set(control, { rendered, written });
      if (current !== written) control.setAttribute("aria-expanded", written);
    });
  };
  const onDetailRequestClick = (event: MouseEvent) => {
    const control = eventElement(event)?.closest<HTMLElement>(DETAIL_REQUEST_CONTROL_SELECTOR);
    const aside = control ? requestedWaitingDetail(control) : null;
    if (!control || !aside) return;
    // The application keeps its Detail open; only its waiting drawer changes.
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPendingDetail();
    cancelTitle();
    clearActivation();
    // A control inside the drawer leaves with it, so focus goes to Details.
    if (detailDrawer(aside)) parkDetailDrawer(aside, aside.contains(ownerDocument.activeElement));
    else {
      openDetailDrawer(aside);
      if (event.detail === 0) requestTitle(aside);
      else control.focus({ preventScroll: true });
    }
    syncDetailRequestControls();
  };
  const openDetailDrawer = (aside: HTMLElement) => {
    aside.dataset.workspaceDetailDrawer = "open";
    detailToggle(aside)?.setAttribute("aria-expanded", "true");
    syncDetailDrawerSpace(aside);
    syncDetailRequestControls();
  };
  // A sidebar drag changes the room beside it without resizing the workspace,
  // so it rechecks waiting once per frame.
  let hostSyncFrame: number | null = null;
  const scheduleHostSync = () => {
    if (hostSyncFrame !== null) return;
    hostSyncFrame = requestAnimationFrame(() => {
      hostSyncFrame = null;
      syncHostState();
    });
  };
  const applySize = (...args: Parameters<typeof applyRegionSize>) => {
    const size = applyRegionSize(...args);
    if (args[2] === "sidebar") scheduleHostSync();
    return size;
  };
  const syncHostState = () => {
    if (pendingDetail && !canOpenPendingDetail(pendingDetail.aside)) cancelPendingDetail();
    if (overlay && sidebarForm(overlay.root) !== "overlay") closeOverlay("none");
    for (const root of allRoots()) {
      // A drawer removed with its panel leaves no space behind in Content.
      for (const content of rootElements(root, ".k2b-app-workspace__content"))
        if (content.style.getPropertyValue("--k2b-detail-space") && !content.querySelector(DETAIL_DRAWER_SELECTOR))
          content.style.removeProperty("--k2b-detail-space");
      for (const aside of rootElements(root, detailSelector)) {
        if (aside.hidden) {
          detailWasWaiting.delete(aside);
          parkDetailDrawer(aside);
          continue;
        }
        const waiting = detailWaiting(aside);
        const before = detailWasWaiting.get(aside);
        detailWasWaiting.set(aside, waiting);
        if (!waiting) {
          // The Details button hides with the waiting; its focus moves to the returning column's title.
          const toggleFocused = detailToggle(aside)?.contains(ownerDocument.activeElement) ?? false;
          parkDetailDrawer(aside);
          if (toggleFocused) focusTitle(aside);
        } else if (detailDrawer(aside)) syncDetailDrawerSpace(aside);
        else if (before !== true && aside.contains(ownerDocument.activeElement)) detailToggle(aside)?.focus({ preventScroll: true });
      }
    }
    syncDetailRequestControls();
  };
  const phone = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 47.999rem)") : null;
  const wide = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 48rem)") : null;
  const detailSelector = ".k2b-app-workspace__detail";
  const grabberSelector = ".k2b-app-workspace__detail-grabber";
  type RememberedItem = {
    item: HTMLElement;
    cell: HTMLElement | null;
    interaction: "pointer" | "keyboard";
    scroller: HTMLElement | null;
    scrollTop: number;
    top: number;
    fresh: boolean;
    /** Pointer, Enter/Space, or assistive activation chose an item outside text entry. */
    chosen: boolean;
  };
  const detailHidden = new WeakMap<HTMLElement, boolean>();
  const remembered = new WeakMap<HTMLElement, RememberedItem>();
  const lastFocus = new WeakMap<HTMLElement, Element>();
  const touchedDetails = new Set<HTMLElement>();
  // Only a panel blocks scrolling for its touch gestures; a document-wide
  // non-passive listener would make every scroll on the page wait for script.
  const touchMoveAsides = new Set<HTMLElement>();
  const titleTabIndices = new Set<HTMLElement>();
  const motionFrames = new Map<HTMLElement, number>();
  const pendingAnchors = new Map<HTMLElement, () => void>();
  const slides = new Map<HTMLElement, () => void>();
  const motionRoots = new Set<HTMLElement>();
  const revealFrames = new Map<HTMLElement, number>();
  const openDetails = (root: HTMLElement) => rootElements(root, detailSelector).filter((aside) => !aside.hidden);
  const closeControl = (aside: HTMLElement) =>
    Array.from(aside.querySelectorAll<HTMLElement>("[data-workspace-detail-close]")).find(
      (control) => control.closest(detailSelector) === aside,
    );
  const closable = (aside: HTMLElement) => aside.hasAttribute("data-workspace-detail-closable") || Boolean(closeControl(aside));
  const requestClose = (aside: HTMLElement) => {
    if (aside.hasAttribute("data-workspace-detail-closable")) aside.dispatchEvent(new CustomEvent(APP_WORKSPACE_DETAIL_CLOSE_EVENT));
    else closeControl(aside)?.click();
  };
  const scrollerOn = (axis: "x" | "y", target: Element, boundary: HTMLElement) => {
    for (let element: Element | null = target; element && boundary.contains(element); element = element.parentElement) {
      if (
        element instanceof HTMLElement &&
        /^(auto|scroll)$/.test(axis === "y" ? getComputedStyle(element).overflowY : getComputedStyle(element).overflowX) &&
        (axis === "y" ? element.scrollHeight > element.clientHeight : element.scrollWidth > element.clientWidth)
      )
        return element;
      if (element === boundary) break;
    }
    return null;
  };
  const verticalScroller = (target: Element, boundary: HTMLElement) => scrollerOn("y", target, boundary);
  const refreshItem = (snapshot: RememberedItem) => {
    snapshot.top = snapshot.item.getBoundingClientRect().top;
    snapshot.scrollTop = snapshot.scroller?.scrollTop ?? 0;
  };
  // Native Enter/Space clicks and pointer clicks continue their initiating event.
  let activationItem: HTMLElement | null = null;
  let activationFrame: number | null = null;
  const clearActivation = () => {
    if (activationFrame !== null) cancelAnimationFrame(activationFrame);
    activationFrame = null;
    activationItem = null;
  };
  const endActivation = () => {
    if (!activationItem) return;
    // Space's native click follows keyup before the next frame.
    if (activationFrame !== null) cancelAnimationFrame(activationFrame);
    activationFrame = requestAnimationFrame(clearActivation);
  };
  const cancelActivation = () => {
    // A cancelled gesture must not open a Detail that appears later.
    if (lastChosen?.interaction === "pointer" && lastChosen.item === activationItem) {
      lastChosen.chosen = false;
      lastChosen = null;
    }
    clearActivation();
  };
  const onChoiceClick = (event: MouseEvent) => {
    const preceded = event.target instanceof Node && Boolean(activationItem?.contains(event.target));
    clearActivation();
    if (event.detail === 0 && !preceded) {
      cancelTitleOnInteraction(event);
      rememberInteraction(event);
    } else if (!(event.target instanceof Node && lastChosen?.item.contains(event.target))) cancelTitleOnInteraction(event);
  };
  // A table row can exceed its scroller's width, so keep the clicked cell for horizontal reveal.
  const rememberInteraction = (event: Event) => {
    const target = eventElement(event);
    const root = target?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!target || !root || !observedRoots.has(root)) return;
    const previous = remembered.get(root);
    if (previous && openDetails(root).length) refreshItem(previous);
    const main = mainElement(root);
    // Collection rows with a roving tab index are items too, though no tab stops.
    const item = target.closest<HTMLElement>(`${FOCUSABLE_SELECTOR}, [tabindex]`);
    if (!main || !item || item === main || !main.contains(item) || item.closest(ROOT_SELECTOR) !== root) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "pointerdown" || event.type === "keydown") activationItem = item;
    const assistive = event instanceof MouseEvent && event.type === "click" && event.detail === 0 && event.button === 0;
    const cell = target.closest<HTMLElement>("td, th");
    const snapshot: RememberedItem = {
      item,
      cell: cell && main.contains(cell) && cell.closest(ROOT_SELECTOR) === root ? cell : null,
      interaction: event instanceof KeyboardEvent || assistive ? "keyboard" : "pointer",
      scroller: verticalScroller(item, main),
      scrollTop: 0,
      top: 0,
      fresh: true,
      // Text entry and focus alone do not choose an item.
      // A modified activation, such as Ctrl/Cmd-click opening a new tab, chooses nothing here.
      chosen:
        ((event instanceof PointerEvent && event.type === "pointerdown" && event.button === 0) ||
          event instanceof KeyboardEvent ||
          assistive) &&
        !(event instanceof MouseEvent || event instanceof KeyboardEvent
          ? event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
          : false) &&
        // Space scrolls on native links; it does not activate them.
        !(
          event instanceof KeyboardEvent &&
          event.key === " " &&
          item.matches("a[href], area[href]") &&
          (!item.hasAttribute("role") || item.getAttribute("role") === "link")
        ) &&
        !target.closest(KEY_OWNER_SELECTOR) &&
        !item.closest("[role='tab'], [role='tablist']"),
    };
    refreshItem(snapshot);
    remembered.set(root, snapshot);
    if (snapshot.chosen) lastChosen = snapshot;
    if (snapshot.chosen) {
      const aside = openDetails(root).find(canOpenPendingDetail);
      if (aside) checkPendingDetail(root, aside, snapshot, event instanceof KeyboardEvent && event.key === " ");
    }
    // Enter in an editor or a field types; only an item that chooses something moves on to its title.
    if (snapshot.chosen && snapshot.interaction === "keyboard") {
      const aside = openDetails(root).find((aside) => isVisible(aside) && (!detailWaiting(aside) || detailDrawer(aside)));
      if (aside) requestTitle(aside, true);
    }
  };
  const onDetailFocusIn = (event: Event) => {
    const target = eventElement(event);
    const root = target?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!target || !root || !observedRoots.has(root)) return;
    lastFocus.set(root, target);
    const previous = remembered.get(root);
    // Pointer focus follows pointerdown; keeping that snapshot also keeps the
    // interaction that opened the panel rather than treating focus as a new one.
    if (previous?.item.contains(target)) {
      const main = mainElement(root);
      if (target !== previous.item && target instanceof HTMLElement && main) {
        previous.item = target;
        previous.scroller = verticalScroller(target, main);
        refreshItem(previous);
      }
      return;
    }
    rememberInteraction(event);
  };
  const titleIn = (aside: HTMLElement) => aside.querySelector<HTMLElement>("h1, h2, h3, [role='heading']");
  let focusingTitle: HTMLElement | null = null;
  const focusTitle = (aside: HTMLElement) => {
    const title = titleIn(aside);
    if (!title) return false;
    if (!title.matches(FOCUSABLE_SELECTOR) && !title.hasAttribute("tabindex")) {
      title.tabIndex = -1;
      titleTabIndices.add(title);
    }
    focusingTitle = title;
    try {
      title.focus({ preventScroll: true });
    } finally {
      focusingTitle = null;
    }
    return true;
  };
  let pendingTitle: { aside: HTMLElement; observer: MutationObserver } | null = null;
  const cancelTitle = () => {
    pendingTitle?.observer.disconnect();
    pendingTitle = null;
  };
  // A step from inside the panel can remove the focused element with the old
  // content, so focus falls to the body. The panel keeps owning the steps until
  // focus or a pointer goes elsewhere, so a quick second J still ends on the title.
  let panelStep: HTMLElement | null = null;
  // The last choice in Main, until another interaction replaces it: a Detail
  // that opens later than that does not take the drawer or the focus.
  let lastChosen: RememberedItem | null = null;
  const cancelTitleOnInteraction = (event: Event) => {
    if (event.type === "pointerdown" || event.type === "keydown") clearActivation();
    if (lastChosen && !(event.target instanceof Node && lastChosen.item.contains(event.target))) {
      lastChosen.chosen = false;
      lastChosen = null;
    }
    if (
      pendingDetail &&
      // Native pointer focus on the chosen item continues its activation.
      !(event.type === "focusin" && event.target instanceof Node && pendingDetail.snapshot.item.contains(event.target))
    )
      cancelPendingDetail();
    if (event.type !== "keydown" && !(event.target instanceof Node && panelStep?.contains(event.target))) panelStep = null;
    if (event.type !== "focusin" || event.target !== focusingTitle) cancelTitle();
  };
  const requestTitle = (aside: HTMLElement, waitForChange = false) => {
    cancelTitle();
    if (aside.hidden || !aside.isConnected) return;
    if (!waitForChange && focusTitle(aside)) return;
    const previousTitle = titleIn(aside);
    const previousText = previousTitle?.textContent;
    // Loading fallbacks and selection changes can produce their heading after
    // the opening interaction. A later user action always takes precedence.
    const observer = new MutationObserver(() => {
      if (aside.hidden || !aside.isConnected) {
        cancelTitle();
        return;
      }
      const title = titleIn(aside);
      if (!title || (waitForChange && title === previousTitle && title.textContent === previousText)) return;
      cancelTitle();
      focusTitle(aside);
    });
    pendingTitle = { aside, observer };
    observer.observe(aside, { childList: true, subtree: true, characterData: true });
    // An element-scoped controller cannot see its own root leave the document.
    observer.observe(ownerDocument, { childList: true, subtree: true });
  };
  const phonePage = (aside: HTMLElement) => aside.dataset.workspaceDetailPhone === "page";
  const setDetent = (aside: HTMLElement, full: boolean) => {
    if (phonePage(aside)) return;
    touchedDetails.add(aside);
    if (full) aside.dataset.workspaceDetailSheet = "full";
    else delete aside.dataset.workspaceDetailSheet;
    aside.querySelector(grabberSelector)?.setAttribute("aria-pressed", String(full));
  };
  const clearDrag = (aside: HTMLElement) => {
    aside.style.removeProperty("--k2b-workspace-detail-sheet-height");
    aside.style.removeProperty("transform");
    delete aside.dataset.workspaceDetailDragging;
  };
  const anchorItem = (root: HTMLElement, aside: HTMLElement, snapshot: RememberedItem | undefined) => {
    if (!wide?.matches || detailDrawer(aside) || !snapshot?.item.isConnected) return;
    if (!mainElement(root)?.contains(snapshot.item) || snapshot.item.closest(ROOT_SELECTOR) !== root) return;
    const scroller = snapshot.scroller;
    if (scroller?.isConnected && scroller.scrollTop === snapshot.scrollTop)
      scroller.scrollTop += snapshot.item.getBoundingClientRect().top - snapshot.top;
  };
  // A moving Detail would cross a framed workspace's edge, so the workspace
  // clips while it slides (see the stylesheet).
  const slide = (root: HTMLElement, aside: HTMLElement) => {
    slides.get(root)?.();
    if (!root.hasAttribute("data-workspace-motion") || prefersReducedMotion() || !wide?.matches) return;
    const end = () => {
      aside.removeEventListener("transitionend", onEnd);
      aside.removeEventListener("transitioncancel", onEnd);
      cancelAnimationFrame(frame);
      slides.delete(root);
      delete root.dataset.workspaceDetailSliding;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === aside && event.propertyName === "transform") end();
    };
    aside.addEventListener("transitionend", onEnd);
    aside.addEventListener("transitioncancel", onEnd);
    // A slow first frame must not end the clip early, so only a panel that
    // does not slide at all ends it in that frame.
    const frame = requestAnimationFrame(() => {
      const sliding = aside
        .getAnimations?.()
        .some((animation) => "transitionProperty" in animation && animation.transitionProperty === "transform");
      if (!sliding) end();
    });
    slides.set(root, end);
    root.dataset.workspaceDetailSliding = "";
  };
  const revealItem = (root: HTMLElement, aside: HTMLElement, snapshot: RememberedItem) => {
    if (phone?.matches && phonePage(aside)) return;
    const pending = revealFrames.get(root);
    if (pending !== undefined) cancelAnimationFrame(pending);
    revealFrames.set(
      root,
      requestAnimationFrame(() => {
        revealFrames.delete(root);
        if (
          !aside.hidden &&
          aside.isConnected &&
          snapshot.item.isConnected &&
          mainElement(root)?.contains(snapshot.item) &&
          snapshot.item.closest(ROOT_SELECTOR) === root
        ) {
          const behavior = prefersReducedMotion() ? "auto" : "smooth";
          const main = mainElement(root);
          const cell = snapshot.cell;
          const target = cell?.isConnected && main?.contains(cell) ? cell : snapshot.item;
          if (phone?.matches && main) {
            // The sheet covers Main's lower part, so the item ends 8px above it;
            // the other edges include the scroller's scroll padding, like scrollIntoView.
            const page = ownerDocument.scrollingElement;
            const vertical = verticalScroller(target, main) ?? page;
            const horizontal = scrollerOn("x", target, main) ?? page;
            const bounds = (scroller: Element | null) => {
              if (!scroller || scroller === page) return null;
              const rect = scroller.getBoundingClientRect();
              const style = ownerWindow.getComputedStyle(scroller);
              const padding = (value: string) => Number.parseFloat(value) || 0;
              return {
                top: rect.top + padding(style.scrollPaddingTop),
                left: rect.left + padding(style.scrollPaddingLeft),
                right: rect.right - padding(style.scrollPaddingRight),
              };
            };
            const box = target.getBoundingClientRect();
            const top = Math.max(0, bounds(vertical)?.top ?? 0);
            const left = Math.max(0, bounds(horizontal)?.left ?? 0);
            const right = Math.min(ownerWindow.innerWidth, bounds(horizontal)?.right ?? Infinity);
            const dy = box.top < top ? box.top - top - 8 : Math.max(0, box.bottom - (ownerWindow.innerHeight - aside.offsetHeight) + 8);
            // As with scrollIntoView's "nearest", an item past both edges stays put
            // and one wider than the view keeps its start in view.
            const dx =
              box.left < left && box.right > right
                ? 0
                : box.left < left
                  ? box.left - left - 8
                  : box.right > right
                    ? Math.min(box.right - right + 8, Math.max(0, box.left - left - 8))
                    : 0;
            if (vertical && vertical === horizontal) {
              if (dy || dx) vertical.scrollBy({ top: dy, left: dx, behavior });
            } else {
              if (dy) vertical?.scrollBy({ top: dy, behavior });
              if (dx) horizontal?.scrollBy({ left: dx, behavior });
            }
          } else target.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
        }
      }),
    );
  };
  let pendingDetail: { aside: HTMLElement; snapshot: RememberedItem; stop: () => void } | null = null;
  const canOpenPendingDetail = (aside: HTMLElement) =>
    aside.isConnected &&
    eventRoot.contains(aside) &&
    !aside.hidden &&
    detailWaiting(aside) &&
    !detailDrawer(aside) &&
    aside.dataset.workspaceDetailChoice !== "request";
  const cancelPendingDetail = () => {
    pendingDetail?.stop();
    pendingDetail = null;
  };
  // Check a completed choice after two frames. If its selection mark arrives
  // later, keep waiting until another interaction replaces the choice.
  const checkPendingDetail = (root: HTMLElement, aside: HTMLElement, snapshot: RememberedItem, space = false) => {
    cancelPendingDetail();
    let frame: number | null = null;
    let observer: MutationObserver | null = null;
    const settle = () => {
      ownerDocument.removeEventListener("click", onClick, true);
      ownerDocument.removeEventListener("keyup", onKeyUp, true);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          const main = mainElement(root);
          if (
            !canOpenPendingDetail(aside) ||
            !snapshot.chosen ||
            !snapshot.item.isConnected ||
            !main?.contains(snapshot.item) ||
            snapshot.item.closest(ROOT_SELECTOR) !== root
          ) {
            cancelPendingDetail();
            return;
          }
          // ARIA marks, and `data-selected` as DataTable and Calendar mark their selection.
          let selected = snapshot.item.closest(SELECTION_MARK_SELECTOR);
          while (selected?.matches(IGNORED_SELECTION_MARK_SELECTOR))
            selected = selected.parentElement?.closest(SELECTION_MARK_SELECTOR) ?? null;
          if (!selected || selected === main || !main.contains(selected)) {
            if (!observer) {
              observer = new MutationObserver(settle);
              observer.observe(main, {
                subtree: true,
                attributes: true,
                attributeFilter: ["aria-selected", "aria-current", "data-selected"],
              });
            }
            return;
          }
          cancelPendingDetail();
          // A control inside a selected row that discloses, toggles, or opens
          // a menu does its own job and selects nothing.
          if (selected !== snapshot.item && snapshot.item.matches(NESTED_CONTROL_SELECTOR)) return;
          snapshot.fresh = false;
          openDetailDrawer(aside);
          revealItem(root, aside, snapshot);
          // The same item keeps its title; another one may still be loading,
          // so focus follows the title that replaces the current one.
          if (snapshot.interaction === "keyboard") {
            focusTitle(aside);
            requestTitle(aside, true);
          }
        });
      });
    };
    const onClick = (event: MouseEvent) => {
      if (event.button === 0 && event.target instanceof Node && snapshot.item.contains(event.target)) settle();
      else cancelPendingDetail();
    };
    // Space activates a button on release, so its check waits for keyup.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") settle();
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      ownerDocument.removeEventListener("click", onClick, true);
      ownerDocument.removeEventListener("keyup", onKeyUp, true);
      ownerDocument.removeEventListener("pointercancel", cancelPendingDetail, true);
    };
    pendingDetail = { aside, snapshot, stop };
    ownerDocument.addEventListener("pointercancel", cancelPendingDetail, true);
    if (space) ownerDocument.addEventListener("keyup", onKeyUp, true);
    else if (snapshot.interaction === "keyboard") settle();
    else ownerDocument.addEventListener("click", onClick, true);
  };
  const detailTransition = (aside: HTMLElement, wasHidden: boolean) => {
    const root = aside.closest<HTMLElement>(ROOT_SELECTOR);
    detailHidden.set(aside, Boolean(aside.hidden));
    if (!root || !observedRoots.has(root) || Boolean(aside.hidden) === wasHidden) return;
    pendingAnchors.get(root)?.();
    slide(root, aside);
    touchedDetails.add(aside);
    const pending = revealFrames.get(root);
    if (pending !== undefined) cancelAnimationFrame(pending);
    revealFrames.delete(root);
    const snapshot = remembered.get(root);
    const followedInteraction = snapshot?.fresh ?? false;
    if (snapshot) snapshot.fresh = false;
    if (aside.hidden) {
      if (pendingDetail?.aside === aside) cancelPendingDetail();
      parkDetailDrawer(aside);
      if (pendingTitle?.aside === aside) cancelTitle();
      if (panelStep === aside) panelStep = null;
      if (root.hasAttribute("data-workspace-motion") && !prefersReducedMotion() && wide?.matches) {
        // Closing holds the detail column until the slide ends; anchor after Main widens.
        const cancel = () => {
          root.removeEventListener("transitionend", onTransitionEnd);
          clearTimeout(timer);
          pendingAnchors.delete(root);
        };
        const finish = () => {
          cancel();
          if (aside.hidden && aside.isConnected) anchorItem(root, aside, snapshot);
        };
        const onTransitionEnd = (event: TransitionEvent) => {
          if (event.target === root && event.propertyName === "--k2b-workspace-detail-track") finish();
        };
        const timer = setTimeout(finish, 300);
        root.addEventListener("transitionend", onTransitionEnd);
        pendingAnchors.set(root, cancel);
      } else anchorItem(root, aside, snapshot);
      const focused = ownerDocument.activeElement;
      if (
        snapshot?.item.isConnected &&
        (aside.contains(lastFocus.get(root) ?? null) || aside.contains(focused) || focused === ownerDocument.body)
      )
        snapshot.item.focus({ preventScroll: true });
      clearDrag(aside);
      if (detailDrag?.aside === aside) finishDetailDrag(true);
      return;
    }
    if (detailWaiting(aside) && !detailDrawer(aside)) {
      if (!followedInteraction || !snapshot?.chosen) return;
      if (aside.dataset.workspaceDetailChoice === "request" && !snapshot.item.matches(DETAIL_REQUEST_CONTROL_SELECTOR)) return;
      openDetailDrawer(aside);
    }
    anchorItem(root, aside, snapshot);
    if (phone?.matches) setDetent(aside, false);
    if (followedInteraction && snapshot) {
      revealItem(root, aside, snapshot);
      if (snapshot.interaction === "keyboard" || phone?.matches) requestTitle(aside);
    }
  };
  const onDetailKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = eventElement(event);
    if (!target || target.closest(KEY_OWNER_SELECTOR)) return;
    if (ownerDocument.querySelector("dialog[open], [aria-modal='true']")) return;
    try {
      // A passive hint does not own the keyboard.
      if (ownerDocument.querySelector(":popover-open:not(.k2b-moved-hint)")) return;
    } catch {
      // Older engines have no popover selector; the other popup guards still apply.
    }
    const root = target.closest<HTMLElement>(ROOT_SELECTOR);
    let aside = target.closest<HTMLElement>(detailSelector);
    if (aside?.hidden || (aside && (!eventRoot.contains(aside) || aside.closest(ROOT_SELECTOR) !== root))) aside = null;
    if (!aside && root && observedRoots.has(root) && (mainElement(root)?.contains(target) || target.closest(DETAIL_TOGGLE_SELECTOR)))
      aside = openDetails(root).find(isVisible) ?? null;
    if (!aside && target === ownerDocument.body) {
      const open = allRoots().flatMap(openDetails).filter(isVisible);
      if (open.length === 1) aside = open[0]!;
    }
    const owningRoot = aside?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!aside || !owningRoot || !isVisible(aside)) return;
    if (event.key === "Escape" && detailDrawer(aside)) {
      parkDetailDrawer(aside, true);
      syncDetailRequestControls();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && closable(aside)) requestClose(aside);
    else if (
      (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") &&
      aside.hasAttribute("data-workspace-detail-steppable")
    ) {
      const main = mainElement(owningRoot);
      const inMain = remembered.get(owningRoot)?.item.contains(target) || main?.contains(target);
      const inPanel = aside.contains(target) || (target === ownerDocument.body && panelStep === aside);
      panelStep = inPanel ? aside : null;
      const previousTitle = inPanel ? titleIn(aside) : null;
      const previousText = previousTitle?.textContent;
      const detail: AppWorkspaceDetailStep = { direction: event.key.toLowerCase() === "j" ? 1 : -1 };
      aside.dispatchEvent(new CustomEvent(APP_WORKSPACE_DETAIL_STEP_EVENT, { detail }));
      const shown = detail.item;
      const item = shown instanceof HTMLElement && main?.contains(shown) && shown.closest(ROOT_SELECTOR) === owningRoot ? shown : null;
      if (item && main) {
        const snapshot: RememberedItem = {
          item,
          cell: null,
          interaction: "keyboard",
          scroller: verticalScroller(item, main),
          scrollTop: 0,
          top: 0,
          fresh: false,
          chosen: false,
        };
        refreshItem(snapshot);
        remembered.set(owningRoot, snapshot);
        revealItem(owningRoot, aside, snapshot);
      }
      const title = titleIn(aside);
      if (item && inMain) item.focus({ preventScroll: true });
      // A panel that swapped its title during the event has the new one now.
      else if (item && inPanel && title && (title !== previousTitle || title.textContent !== previousText)) focusTitle(aside);
      // This key's capture cancelled an earlier step's title request, so a
      // step from the body, even past the last item, asks again.
      else if (inPanel && (item || target === ownerDocument.body)) requestTitle(aside, Boolean(item));
    } else if (event.key === "F6") {
      if (aside.contains(target)) {
        const item = remembered.get(owningRoot)?.item;
        const main = mainElement(owningRoot);
        (item?.isConnected ? item : main ? tabStopsIn(main)[0] : null)?.focus({ preventScroll: true });
      } else focusTitle(aside);
    } else return;
    event.preventDefault();
  };

  type DetailDrag = {
    aside: HTMLElement;
    source: "pointer" | "sheet" | "drawer";
    target: Element;
    pointerId: number;
    startX: number;
    startY: number;
    startHeight: number;
    full: boolean;
    dx: number;
    dy: number;
    time: number;
    velocity: number;
    moved: boolean;
    releaseTextSelection?: () => void;
  };
  let detailDrag: DetailDrag | null = null;
  let detailDragFrame: number | null = null;
  let suppressedClick: HTMLElement | null = null;
  let suppressedClickTimer: ReturnType<typeof setTimeout> | null = null;
  const paintDetailDrag = () => {
    detailDragFrame = null;
    const drag = detailDrag;
    if (!drag?.moved) return;
    drag.aside.dataset.workspaceDetailDragging = "true";
    touchedDetails.add(drag.aside);
    if (drag.source === "drawer") drag.aside.style.transform = `translateX(${Math.max(0, drag.dx)}px)`;
    else {
      const height = ownerWindow.innerHeight;
      drag.aside.style.setProperty(
        "--k2b-workspace-detail-sheet-height",
        `${clamp(drag.startHeight - drag.dy, 0, Math.max(0, height - 8))}px`,
      );
    }
  };
  const scheduleDetailDrag = () => {
    if (detailDragFrame === null) detailDragFrame = requestAnimationFrame(paintDetailDrag);
  };
  const finishDetailDrag = (cancelled: boolean) => {
    const drag = detailDrag;
    if (!drag) return;
    detailDrag = null;
    if (detailDragFrame !== null) cancelAnimationFrame(detailDragFrame);
    detailDragFrame = null;
    drag.releaseTextSelection?.();
    if (drag.source === "pointer") {
      if (drag.target instanceof HTMLElement && drag.target.hasPointerCapture?.(drag.pointerId))
        drag.target.releasePointerCapture(drag.pointerId);
      if (drag.moved) {
        suppressedClick = drag.aside;
        if (suppressedClickTimer !== null) clearTimeout(suppressedClickTimer);
        suppressedClickTimer = setTimeout(() => {
          suppressedClick = null;
          suppressedClickTimer = null;
        }, 0);
      }
    }
    clearDrag(drag.aside);
    if (cancelled || !drag.moved) return;
    if (drag.source === "drawer") {
      if (drag.dx > 80 || (drag.dx > 30 && drag.velocity > 0.5))
        parkDetailDrawer(drag.aside, drag.aside.contains(ownerDocument.activeElement));
    } else if (drag.dy > 60) {
      setDetent(drag.aside, false);
      if (!drag.full && closable(drag.aside)) requestClose(drag.aside);
    } else if (drag.dy < -60) setDetent(drag.aside, true);
  };
  const beginDetailDrag = (aside: HTMLElement, target: Element, source: DetailDrag["source"], x: number, y: number, pointerId: number) => {
    detailDrag = {
      aside,
      target,
      source,
      pointerId,
      startX: x,
      startY: y,
      startHeight: aside.getBoundingClientRect().height,
      full: aside.dataset.workspaceDetailSheet === "full",
      dx: 0,
      dy: 0,
      time: performance.now(),
      velocity: 0,
      moved: false,
    };
    return detailDrag;
  };
  const onSheetPointerDown = (event: Event) => {
    if (!(event instanceof PointerEvent) || !phone?.matches || event.button !== 0 || !event.isPrimary || claimedDetailGestures.has(event))
      return;
    const target = eventElement(event);
    const aside = target?.closest<HTMLElement>(detailSelector);
    const root = aside?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!target || !aside || !root || aside.hidden || !observedRoots.has(root) || target.closest(ROOT_SELECTOR) !== root) return;
    if (phonePage(aside)) return;
    const grabber = target.closest<HTMLElement>(grabberSelector);
    if (
      !grabber &&
      (!target.closest(".k2b-detail-panel__header") ||
        target.closest("a, button, input, select, textarea, [role='button'], [contenteditable]:not([contenteditable='false'])"))
    )
      return;
    claimedDetailGestures.add(event);
    if (detailDrag) finishDetailDrag(true);
    const drag = beginDetailDrag(aside, grabber ?? target, "pointer", event.clientX, event.clientY, event.pointerId);
    drag.releaseTextSelection = suppressTextSelection(event.pointerId);
    if (drag.target instanceof HTMLElement) drag.target.setPointerCapture?.(event.pointerId);
    aside.dataset.workspaceDetailDragging = "true";
    touchedDetails.add(aside);
  };
  const onSheetPointerMove = (event: PointerEvent) => {
    const drag = detailDrag;
    if (!drag || drag.source !== "pointer" || drag.pointerId !== event.pointerId) return;
    drag.dy = event.clientY - drag.startY;
    drag.moved ||= Math.abs(drag.dy) > 4;
    if (drag.moved) scheduleDetailDrag();
  };
  const onSheetPointerEnd = (event: Event) => {
    if (!(event instanceof PointerEvent)) return;
    if (detailDrag?.source === "pointer" && detailDrag.pointerId === event.pointerId) finishDetailDrag(event.type !== "pointerup");
  };
  const onGrabberClick = (event: Event) => {
    const target = eventElement(event);
    const grabber = target?.closest(grabberSelector);
    const aside = grabber?.closest<HTMLElement>(detailSelector);
    if (!aside || aside.hidden || phonePage(aside) || !phone?.matches || claimedToggleClicks.has(event)) return;
    claimedToggleClicks.add(event);
    if (suppressedClick === aside && event instanceof MouseEvent && event.detail !== 0) {
      event.preventDefault();
      suppressedClick = null;
      return;
    }
    setDetent(aside, aside.dataset.workspaceDetailSheet !== "full");
  };
  const ownsTouchGesture = (target: Element, aside: HTMLElement, source: "sheet" | "drawer") => {
    for (let element: Element | null = target; element && element !== aside; element = element.parentElement) {
      if (
        element.matches(
          "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [draggable='true'], canvas",
        )
      )
        return true;
      const action = getComputedStyle(element).getPropertyValue("touch-action");
      const horizontal = /\bpan-(x|left|right)\b/.test(action);
      const vertical = /\bpan-(y|up|down)\b/.test(action);
      if (action.trim() === "none" || (source === "drawer" ? vertical && !horizontal : horizontal && !vertical)) return true;
    }
    return false;
  };
  const onDetailTouchStart = (event: Event) => {
    if (!(event instanceof TouchEvent) || event.touches.length !== 1) {
      if (detailDrag && detailDrag.source !== "pointer") finishDetailDrag(true);
      return;
    }
    if (detailDrag || claimedDetailGestures.has(event)) return;
    const target = eventElement(event);
    const aside = target?.closest<HTMLElement>(detailSelector);
    const touch = event.touches[0];
    const root = aside?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!target || !aside || !root || aside.hidden || !touch || !observedRoots.has(root) || target.closest(ROOT_SELECTOR) !== root) return;
    if (phone?.matches && phonePage(aside)) return;
    if (phone?.matches && (verticalScroller(target, aside) ?? aside).scrollTop <= 0) {
      if (!ownsTouchGesture(target, aside, "sheet"))
        beginDetailDrag(aside, target, "sheet", touch.clientX, touch.clientY, touch.identifier);
    } else if (wide?.matches && detailDrawer(aside)) {
      if (!ownsTouchGesture(target, aside, "drawer"))
        beginDetailDrag(aside, target, "drawer", touch.clientX, touch.clientY, touch.identifier);
    }
    if (detailDrag) claimedDetailGestures.add(event);
  };
  const onDetailTouchMove = (event: Event) => {
    const drag = detailDrag;
    if (!(event instanceof TouchEvent) || !drag || drag.source === "pointer") return;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === drag.pointerId);
    if (!touch || event.touches.length !== 1) {
      finishDetailDrag(true);
      return;
    }
    const dx = touch.clientX - drag.startX;
    const dy = touch.clientY - drag.startY;
    const now = performance.now();
    drag.velocity = (dx - drag.dx) / Math.max(1, now - drag.time);
    drag.time = now;
    drag.dx = dx;
    drag.dy = dy;
    if (!drag.moved) {
      if (drag.source === "sheet") {
        if (dy < 0 || (verticalScroller(drag.target, drag.aside) ?? drag.aside).scrollTop > 0) {
          finishDetailDrag(true);
          return;
        }
        if (dy <= 4) return;
      } else {
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 8) return;
        if (dx <= Math.abs(dy)) {
          finishDetailDrag(true);
          return;
        }
        for (let element: Element | null = drag.target; element && drag.aside.contains(element); element = element.parentElement) {
          if (
            element instanceof HTMLElement &&
            /^(auto|scroll)$/.test(getComputedStyle(element).overflowX) &&
            element.scrollWidth > element.clientWidth &&
            element.scrollLeft > 0
          ) {
            finishDetailDrag(true);
            return;
          }
          if (element === drag.aside) break;
        }
      }
      drag.moved = true;
    }
    event.preventDefault();
    scheduleDetailDrag();
  };
  const onDetailTouchEnd = (event: Event) => {
    if (detailDrag && detailDrag.source !== "pointer") finishDetailDrag(event.type === "touchcancel");
  };
  const onPanelDoubleClick = (event: Event) => {
    const handle = resizeHandle(event);
    const root = handle?.closest<HTMLElement>(ROOT_SELECTOR);
    const kind = handle ? resizeKind(handle) : null;
    if (
      !handle ||
      !root ||
      (kind !== "detail" && kind !== "pane") ||
      !workspaceResizable(root) ||
      !controlsResizableRegion(root, handle, kind)
    )
      return;
    const key = kind === "pane" ? "paneWidths" : "detailWidths";
    const widths = { ...layoutState[key] };
    delete widths[panelId(handle)];
    layoutState = { ...layoutState, [key]: widths };
    const variable = appWorkspacePanelVariable(kind, panelId(handle));
    root.style.removeProperty(variable);
    // An SSR ancestor may still supply the old preference until the next request.
    if (getComputedStyle(root).getPropertyValue(variable).trim()) {
      const spec =
        readAppWorkspaceWidth(handle.dataset.workspaceDefaultSize) ??
        (kind === "pane" ? APP_WORKSPACE_PANE_DEFAULT : APP_WORKSPACE_DETAIL_DEFAULT);
      // A share must resolve at the pane, where the workspace length exists.
      // `initial` clears an inherited SSR preference and restores its CSS fallback.
      root.style.setProperty(variable, typeof spec === "number" ? `${spec}px` : "initial");
    }
    // The siblings fit again around the default width, also in a Main without levels.
    if (kind === "pane") reconcilePanes(root, layoutState);
    updateHandleValue(root, handle, kind, currentSize(root, handle, kind));
    options.writeState?.(layoutState);
  };

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

  // A level resize starts from what is on screen. When the stored widths do
  // not fit beside the flexible level, CSS shrinks the resizable levels (a
  // level without a separator does not shrink), so a step from a shrunk width
  // would land on a preference that shrinks again and jump. The visible
  // resizable levels therefore take their rendered widths as preferences when
  // a step really moves; then they fit, and the step moves exactly by its
  // size. All widths are measured before any is written, because each write
  // reflows the others.
  const settleLevels = (root: HTMLElement, handle: HTMLElement) => {
    const main = handle.closest<HTMLElement>(".k2b-app-workspace__main");
    if (!main?.hasAttribute("data-workspace-levels")) return;
    const widths = Array.from(main.querySelectorAll<HTMLElement>(HANDLE_SELECTOR))
      .filter((other) => other.closest(".k2b-app-workspace__main") === main && resizeKind(other) === "pane")
      .flatMap((other) => {
        const panel = controlledPanel(root, other);
        return isVisible(panel) && !flexibleLevel(panel) && panel.dataset.workspaceResizable === "true"
          ? [{ id: panelId(other), width: Math.round(elementSize(panel, "pane")) }]
          : [];
      });
    for (const { id, width } of widths) {
      if (layoutState.paneWidths?.[id] === width) continue;
      root.style.setProperty(appWorkspacePanelVariable("pane", id), `${width}px`);
      layoutState = { ...layoutState, paneWidths: { ...layoutState.paneWidths, [id]: width } };
    }
  };

  const flushPointerMove = () => {
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
    if (!active || pendingClient === null) return;
    const client = pendingClient;
    pendingClient = null;
    const requested = active.startSize + (client - active.startClient) * active.direction;
    // A press without movement, or a drag that the limits stop, changes no
    // level preference, also not a sibling's.
    if (!active.moved && client !== active.startClient && active.kind === "pane" && levelsMain(active.handle)) {
      const { min, max } = sizeLimits(active.root, active.handle, "pane");
      if (clamp(requested, min, max) === Math.round(currentSize(active.root, active.handle, "pane"))) return;
      settleLevels(active.root, active.handle);
    }
    active.moved ||= client !== active.startClient;
    // Below half the smallest visible width a hideable sidebar stays at its
    // minimum and previews hiding; dragging back out resumes the live width.
    const hiding =
      active.kind === "sidebar" && sidebarHideable(active.root) && requested < sizeLimits(active.root, active.handle, active.kind).min / 2;
    if (hiding !== active.hiding) {
      active.hiding = hiding;
      previewSidebarHidden(active.root, hiding);
    }
    if (!hiding)
      active.liveSize = applySize(active.root, active.handle, active.kind, requested, { snapSidebar: active.kind !== "sidebar" });
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
    if (finished.hiding) {
      // The request comes first, while the layout is still the one on screen,
      // so the host sees the sidebar disappear in a single change. The width
      // before the drag then stays the remembered width for the next time it
      // shows; a host that declines the request gets that width back.
      sidebarElement(finished.root)?.dispatchEvent(new CustomEvent(APP_WORKSPACE_SIDEBAR_HIDE_EVENT));
      previewSidebarHidden(finished.root, false);
      applySize(finished.root, finished.handle, "sidebar", finished.startSize);
    } else if (finished.moved) {
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
    finished.releaseTextSelection();
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
      hiding: false,
      direction: resizeDirection(handle, kind),
      releaseTextSelection: suppressTextSelection(event.pointerId),
    };
    root.dataset.workspaceResizeActive = kind;
    handle.dataset.workspaceResizeActive = "true";
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
    if (kind === "pane" && levelsMain(handle)) {
      // A step that the limits stop changes no preference, also not a sibling's.
      if (clamp(requested, min, max) === Math.round(current)) return;
      settleLevels(root, handle);
    }
    persistSize(handle, kind, applySize(root, handle, kind, requested));
    if (kind === "sidebar" || kind === "detail") reconcilePanes(root, layoutState);
  };

  const allRoots = () => {
    const nested = Array.from(eventRoot.querySelectorAll<HTMLElement>(ROOT_SELECTOR));
    return eventRoot instanceof HTMLElement && eventRoot.matches(ROOT_SELECTOR) ? [eventRoot, ...nested] : nested;
  };
  // Remember only attributes we own; application-set inert survives every transition.
  const phonePageInerted = new Set<HTMLElement>();
  const syncPhonePages = () => {
    const regions = new Set<HTMLElement>();
    if (phone?.matches) {
      for (const root of allRoots()) {
        if (!root.isConnected) continue;
        for (const aside of openDetails(root).filter(phonePage)) {
          for (let node: HTMLElement | null = aside; node && node !== root; node = node.parentElement) {
            const parent: HTMLElement | null = node.parentElement;
            if (parent) overlayRegions(parent, aside).forEach((region) => regions.add(region));
          }
        }
      }
    }
    phonePageInerted.forEach((region) => {
      if (regions.has(region)) return;
      region.removeAttribute("inert");
      phonePageInerted.delete(region);
    });
    regions.forEach((region) => {
      if (region.hasAttribute("inert")) return;
      region.setAttribute("inert", "");
      phonePageInerted.add(region);
    });
  };
  const roots = () => {
    // A hidden or zero-width workspace measures 0, which drives every limit
    // down to its minimum — reconciling one would overwrite its variables and
    // `aria-valuenow` with that minimum for good.
    return allRoots().filter((root) => getComputedStyle(root).display !== "none" && root.getBoundingClientRect().width > 0);
  };
  const reconcile = () => {
    if (detailDrag && (detailDrag.source === "drawer" ? !wide?.matches || !detailDrawer(detailDrag.aside) : !phone?.matches))
      finishDetailDrag(true);
    allRoots().forEach((root) => {
      if (!phone?.matches) {
        for (const aside of rootElements(root, detailSelector)) {
          if (aside.dataset.workspaceDetailSheet === "full") setDetent(aside, false);
        }
      }
    });
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
          if (persisted !== undefined) applySize(root, handle, kind, persisted, { reserveMainMinimum: false });
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
  };

  // Geometry can change without a window resize: a parent can resize the
  // workspace, or a detail/pane can open. All sources share one frame so a
  // transition performs at most one layout reconciliation.
  let reconcileFrame: number | null = null;
  const scheduleReconcile = () => {
    if (reconcileFrame !== null) return;
    reconcileFrame = requestAnimationFrame(() => {
      reconcileFrame = null;
      reconcile();
      // Reconciling can restore a drawer's persisted width; its trail space follows.
      for (const root of allRoots()) for (const aside of rootElements(root, DETAIL_DRAWER_SELECTOR)) syncDetailDrawerSpace(aside);
    });
  };
  const onResize = () => {
    syncHostState();
    scheduleReconcile();
  };

  const observedRoots = new Set<HTMLElement>();
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          syncHostState();
          scheduleReconcile();
        });
  // A host can change its width while a workspace with a fixed width keeps
  // its own, so the controller also watches each root's nearest named host.
  const observedHosts = new Set<Element>();
  // Found once per root: reading styles on every mutation would cost a style pass.
  const rootHosts = new WeakMap<HTMLElement, Element | null>();
  const hostOf = (root: HTMLElement) => {
    if (rootHosts.has(root)) return rootHosts.get(root)!;
    let host: Element | null = null;
    for (let element = root.parentElement; element && !host; element = element.parentElement)
      if (getComputedStyle(element).containerName.split(/\s+/).includes("k2b-app-area")) host = element;
    rootHosts.set(root, host);
    return host;
  };
  const syncObservedRoots = () => {
    const hosts = new Set(
      allRoots()
        .map(hostOf)
        .filter((host): host is Element => host !== null),
    );
    observedHosts.forEach((host) => {
      if (hosts.has(host)) return;
      resizeObserver?.unobserve(host);
      observedHosts.delete(host);
    });
    hosts.forEach((host) => {
      if (observedHosts.has(host)) return;
      observedHosts.add(host);
      resizeObserver?.observe(host);
    });
    for (const elements of [touchedDetails, titleTabIndices, motionRoots]) {
      elements.forEach((element) => {
        if (!element.isConnected) elements.delete(element);
      });
    }
    const next = new Set(allRoots());
    observedRoots.forEach((root) => {
      if (!next.has(root)) {
        pendingAnchors.get(root)?.();
        slides.get(root)?.();
        resizeObserver?.unobserve(root);
        const frame = motionFrames.get(root);
        if (frame !== undefined) cancelAnimationFrame(frame);
        motionFrames.delete(root);
        observedRoots.delete(root);
      }
    });
    touchMoveAsides.forEach((aside) => {
      if (aside.isConnected) return;
      aside.removeEventListener("touchmove", onDetailTouchMove);
      touchMoveAsides.delete(aside);
    });
    next.forEach((root) => {
      rootElements(root, detailSelector).forEach((aside) => {
        if (!detailHidden.has(aside)) detailHidden.set(aside, Boolean(aside.hidden));
        if (touchMoveAsides.has(aside)) return;
        aside.addEventListener("touchmove", onDetailTouchMove, { passive: false });
        touchMoveAsides.add(aside);
      });
      if (observedRoots.has(root)) return;
      observedRoots.add(root);
      resizeObserver?.observe(root);
      if (!root.hasAttribute("data-workspace-motion")) {
        motionRoots.add(root);
        motionFrames.set(
          root,
          requestAnimationFrame(() => {
            motionFrames.set(
              root,
              requestAnimationFrame(() => {
                motionFrames.delete(root);
                if (observedRoots.has(root)) root.dataset.workspaceMotion = "true";
              }),
            );
          }),
        );
      }
    });
  };
  const layoutNode = (node: Node) =>
    node instanceof Element && (node.matches(LAYOUT_REGION_SELECTOR) || Boolean(node.querySelector(LAYOUT_REGION_SELECTOR)));
  const mutationObserver =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          if (
            records.some(
              (record) =>
                record.type === "childList" ||
                ["hidden", "aria-controls", "aria-expanded", "data-workspace-detail-drawer"].includes(record.attributeName ?? ""),
            )
          )
            syncDetailRequestControls();
          syncPhonePages();
          if (pendingTitle && (pendingTitle.aside.hidden || !pendingTitle.aside.isConnected)) cancelTitle();
          if (
            pendingDetail &&
            (!canOpenPendingDetail(pendingDetail.aside) || !pendingDetail.snapshot.chosen || !pendingDetail.snapshot.item.isConnected)
          )
            cancelPendingDetail();
          // Hiding or removing the sidebar, or its button, ends the overlay.
          if (overlay && (overlay.sidebar.hidden || !overlay.sidebar.isConnected || !overlay.toggle.isConnected)) closeOverlay("kept");
          const details = new Set<HTMLElement>();
          for (const record of records) {
            if (
              record.type === "attributes" &&
              record.attributeName === "hidden" &&
              record.target instanceof HTMLElement &&
              record.target.matches(detailSelector) &&
              !details.has(record.target)
            ) {
              details.add(record.target);
              detailTransition(record.target, detailHidden.get(record.target) ?? record.oldValue !== null);
            }
          }
          const changed = records.some((record) =>
            record.type === "attributes"
              ? record.target instanceof Element && record.target.matches(LAYOUT_REGION_SELECTOR)
              : [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(layoutNode),
          );
          if (!changed) return;
          syncObservedRoots();
          // A new width token or a removed panel can end waiting without any box resizing.
          if (
            records.some(
              (record) =>
                record.type === "childList" || record.attributeName === "data-width" || record.attributeName === "data-workspace-main-min",
            )
          )
            syncHostState();
          scheduleReconcile();
        });

  eventRoot.addEventListener("pointerdown", onPointerDown as EventListener);
  eventRoot.addEventListener("click", onClick as EventListener);
  ownerDocument.addEventListener("keydown", onOverlayKeyDown);
  ownerWindow.addEventListener("keydown", onDetailKeyDown);
  ownerDocument.addEventListener("focusin", cancelTitleOnInteraction, true);
  ownerDocument.addEventListener("pointerdown", cancelTitleOnInteraction, true);
  ownerDocument.addEventListener("keydown", cancelTitleOnInteraction, true);
  ownerDocument.addEventListener("click", onDetailRequestClick, true);
  ownerDocument.addEventListener("click", onChoiceClick, true);
  ownerDocument.addEventListener("keyup", endActivation, true);
  ownerDocument.addEventListener("pointerup", endActivation, true);
  ownerDocument.addEventListener("pointercancel", cancelActivation, true);
  eventRoot.addEventListener("pointerdown", rememberInteraction, true);
  eventRoot.addEventListener("keydown", rememberInteraction, true);
  eventRoot.addEventListener("focusin", onDetailFocusIn);
  eventRoot.addEventListener("pointerdown", onSheetPointerDown);
  eventRoot.addEventListener("click", onGrabberClick);
  eventRoot.addEventListener("dblclick", onPanelDoubleClick);
  window.addEventListener("pointermove", onSheetPointerMove);
  window.addEventListener("pointerup", onSheetPointerEnd);
  window.addEventListener("pointercancel", onSheetPointerEnd);
  eventRoot.addEventListener("lostpointercapture", onSheetPointerEnd);
  eventRoot.addEventListener("touchstart", onDetailTouchStart, { passive: true });
  eventRoot.addEventListener("touchend", onDetailTouchEnd);
  eventRoot.addEventListener("touchcancel", onDetailTouchEnd);
  phone?.addEventListener("change", syncHostState);
  phone?.addEventListener("change", syncPhonePages);
  eventRoot.addEventListener("keydown", onKeyDown as EventListener);
  eventRoot.addEventListener("focusin", onFocusIn as EventListener);
  window.addEventListener("resize", onResize);
  syncPhonePages();
  syncObservedRoots();
  syncDetailRequestControls();
  mutationObserver?.observe(eventRoot, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      "hidden",
      "aria-controls",
      "aria-expanded",
      "data-workspace-detail-drawer",
      "data-workspace-level-shown",
      "data-width",
      "data-workspace-main-min",
      "data-workspace-default-size",
    ],
    childList: true,
    subtree: true,
  });
  scheduleReconcile();
  return () => {
    phonePageInerted.forEach((region) => region.removeAttribute("inert"));
    phonePageInerted.clear();
    phone?.removeEventListener("change", syncPhonePages);
    cancelTitle();
    cancelPendingDetail();
    pendingAnchors.forEach((cancel) => cancel());
    slides.forEach((end) => end());
    stopScrollFades();
    finishDetailDrag(true);
    if (suppressedClickTimer !== null) clearTimeout(suppressedClickTimer);
    motionFrames.forEach(cancelAnimationFrame);
    revealFrames.forEach(cancelAnimationFrame);
    motionRoots.forEach((root) => delete root.dataset.workspaceMotion);
    touchedDetails.forEach((aside) => {
      clearDrag(aside);
      delete aside.dataset.workspaceDetailSheet;
      aside.querySelector(grabberSelector)?.setAttribute("aria-pressed", "false");
    });
    titleTabIndices.forEach((title) => title.removeAttribute("tabindex"));
    ownerWindow.removeEventListener("keydown", onDetailKeyDown);
    ownerDocument.removeEventListener("focusin", cancelTitleOnInteraction, true);
    ownerDocument.removeEventListener("pointerdown", cancelTitleOnInteraction, true);
    ownerDocument.removeEventListener("keydown", cancelTitleOnInteraction, true);
    clearActivation();
    ownerDocument.removeEventListener("click", onChoiceClick, true);
    ownerDocument.removeEventListener("keyup", endActivation, true);
    ownerDocument.removeEventListener("pointerup", endActivation, true);
    ownerDocument.removeEventListener("pointercancel", cancelActivation, true);
    eventRoot.removeEventListener("pointerdown", rememberInteraction, true);
    eventRoot.removeEventListener("keydown", rememberInteraction, true);
    eventRoot.removeEventListener("focusin", onDetailFocusIn);
    eventRoot.removeEventListener("pointerdown", onSheetPointerDown);
    eventRoot.removeEventListener("click", onGrabberClick);
    eventRoot.removeEventListener("dblclick", onPanelDoubleClick);
    window.removeEventListener("pointermove", onSheetPointerMove);
    window.removeEventListener("pointerup", onSheetPointerEnd);
    window.removeEventListener("pointercancel", onSheetPointerEnd);
    eventRoot.removeEventListener("lostpointercapture", onSheetPointerEnd);
    eventRoot.removeEventListener("touchstart", onDetailTouchStart);
    touchMoveAsides.forEach((aside) => aside.removeEventListener("touchmove", onDetailTouchMove));
    eventRoot.removeEventListener("touchend", onDetailTouchEnd);
    eventRoot.removeEventListener("touchcancel", onDetailTouchEnd);
    // Flush the latest coalesced pointer sample before listeners and frames are
    // torn down, so unmounting during a drag cannot lose the final size.
    stopResize();
    if (reconcileFrame !== null) cancelAnimationFrame(reconcileFrame);
    if (hostSyncFrame !== null) cancelAnimationFrame(hostSyncFrame);
    mutationObserver?.disconnect();
    detailRequestExpanded.forEach((state, control) => restoreDetailRequestExpanded(control, state));
    detailRequestExpanded.clear();
    ownerDocument.removeEventListener("click", onDetailRequestClick, true);
    resizeObserver?.disconnect();
    observedRoots.clear();
    observedHosts.clear();
    closeOverlay("none");
    eventRoot.removeEventListener("pointerdown", onPointerDown as EventListener);
    eventRoot.removeEventListener("click", onClick as EventListener);
    ownerDocument.removeEventListener("keydown", onOverlayKeyDown);
    phone?.removeEventListener("change", syncHostState);
    eventRoot.removeEventListener("keydown", onKeyDown as EventListener);
    eventRoot.removeEventListener("focusin", onFocusIn as EventListener);
    window.removeEventListener("resize", onResize);
  };
};
