import { dropdownPosition } from "../actions/Dropdown";

/**
 * Marks the root of a controller. A controller owns the titles whose nearest
 * marked ancestor is its root, so a title that installed its own controller
 * before the document's keeps it, and a title inside a marked root installs
 * none.
 */
export const PAGE_TITLE_CONTROLLER_ATTRIBUTE = "data-k2b-page-title-controller";

const TRAIL = ".k2b-page-title__trail";
const PATH = ".k2b-page-title__path";

/**
 * Shows the whole path when it fits. Otherwise the middle collapses into "…",
 * from the second level towards the parent, then the first level too. The
 * parent always stays, because it is where one step up leads. The path keeps
 * its one-line height in every state, so collapsing never moves the title.
 */
const fit = (path: HTMLElement) => {
  const crumbs = [...path.querySelectorAll<HTMLElement>(":scope > .k2b-page-title__crumb")];
  const more = path.querySelector<HTMLElement>(":scope > .k2b-page-title__more");
  if (!more) return;
  for (const crumb of crumbs) crumb.hidden = false;
  more.hidden = true;
  path.removeAttribute("data-tight");
  if (!path.clientWidth) return;
  const overflowing = () => path.scrollWidth > path.clientWidth + 0.5;
  if (overflowing()) {
    more.hidden = false;
    for (let index = 1; index < crumbs.length - 1 && overflowing(); index += 1) crumbs[index]!.hidden = true;
    if (overflowing()) crumbs[0]!.hidden = true;
    // The parent alone still does not fit: it truncates instead.
    if (overflowing()) path.setAttribute("data-tight", "");
  }
  const hidden = new Set(crumbs.filter((crumb) => crumb.hidden).map((crumb) => crumb.dataset.index));
  const menu = path.closest(TRAIL)?.querySelector<HTMLElement>(".k2b-page-title__menu");
  // The menu lists the hidden levels in order, each indented one step below the one before.
  let level = 0;
  for (const item of menu?.querySelectorAll<HTMLElement>("[data-index]") ?? []) {
    item.hidden = !hidden.has(item.dataset.index);
    if (!item.hidden) item.style.setProperty("--k2b-page-title-level", String(level++));
  }
  if (!hidden.size && menu?.matches(":popover-open")) menu.hidePopover();
};

const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>("a[data-index]:not([hidden])")];

/** Below the row that holds the title, from the "…" button on, so the menu never covers the title. */
const place = (menu: HTMLElement, button: HTMLElement) => {
  const row = button.closest(".k2b-page-title")?.parentElement ?? button;
  const anchor = button.getBoundingClientRect();
  const below = new DOMRect(
    anchor.left,
    anchor.top,
    anchor.width,
    Math.max(anchor.bottom, row.getBoundingClientRect().bottom) - anchor.top,
  );
  const rect = dropdownPosition(below, menu.getBoundingClientRect(), "bottom-right", {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.top}px`;
};

/**
 * Collapses every page title path under `root` to the space it has and runs
 * the "…" menu of the hidden levels. Titles that appear later, for example
 * when an island renders, are picked up as well. Returns the disposer.
 */
export const installPageTitleController = (root: Element | Document = document): (() => void) => {
  if (typeof ResizeObserver === "undefined") return () => {};
  // A document by its node type (9): `Document` and `Node` are not globals in every DOM implementation.
  const owner = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
  owner.setAttribute(PAGE_TITLE_CONTROLLER_ATTRIBUTE, "");
  const owns = (element: Element) => element.closest(`[${PAGE_TITLE_CONTROLLER_ATTRIBUTE}]`) === owner;
  const observed = new Set<Element>();
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const path = entry.target.querySelector<HTMLElement>(PATH);
      if (path) fit(path);
    }
  });
  /** Follows the paths that appeared, drops those that left, and fits the new ones and the `changed` ones. */
  const scan = (changed: Iterable<Element> = []) => {
    for (const trail of observed) {
      if (trail.isConnected) continue;
      resize.unobserve(trail);
      observed.delete(trail);
    }
    const due = new Set([...changed].filter((trail) => observed.has(trail)));
    for (const trail of root.querySelectorAll<HTMLElement>(TRAIL)) {
      if (observed.has(trail) || !owns(trail) || !trail.querySelector(PATH)) continue;
      observed.add(trail);
      resize.observe(trail);
      due.add(trail);
    }
    for (const trail of due) {
      const path = trail.querySelector<HTMLElement>(PATH);
      if (path) fit(path);
    }
  };
  // Islands render after the document, and a trail can change its levels; only those changes need a fit. A
  // trail's size changes reach the resize observer, so the rest of a busy page costs no layout.
  const holdsTrail = (node: Node) => node.nodeType === 1 && ((node as Element).matches(TRAIL) || !!(node as Element).querySelector(TRAIL));
  const changed = new Set<Element>();
  let arrivals = false;
  let queued = false;
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      const trail = target?.closest(TRAIL);
      if (trail) changed.add(trail);
      else if (record.type === "childList") arrivals ||= [...record.addedNodes, ...record.removedNodes].some(holdsTrail);
    }
    if (queued || (!arrivals && !changed.size)) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      arrivals = false;
      const due = [...changed];
      changed.clear();
      scan(due);
    });
  });
  mutations.observe(root, { childList: true, subtree: true, characterData: true });
  scan();

  const onClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLElement>(".k2b-page-title__more-button");
    const menu = button?.closest(TRAIL)?.querySelector<HTMLElement>(".k2b-page-title__menu");
    if (!button || !menu || !owns(button)) return;
    // The button names its menu through `popovertarget`; opening here places it before the first paint.
    event.preventDefault();
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
      return;
    }
    menu.showPopover();
    place(menu, button);
    menuItems(menu)[0]?.focus();
  };
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    const menu = (event.target as Element | null)?.closest?.<HTMLElement>(".k2b-page-title__menu");
    if (!menu || !owns(menu) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    const items = menuItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      key === "Home" ? 0 : key === "End" ? items.length - 1 : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };
  const onToggle = (event: Event) => {
    const menu = event.target as HTMLElement;
    if (!menu.matches?.(".k2b-page-title__menu") || !owns(menu) || (event as ToggleEvent).newState !== "closed") return;
    // Escape and light dismiss return focus to the button that opened the menu.
    const button = menu.closest(TRAIL)?.querySelector<HTMLElement>(".k2b-page-title__more-button");
    if (button && (!document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement)))
      button.focus();
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeyDown);
  // `toggle` does not bubble; the capture phase still sees it.
  root.addEventListener("toggle", onToggle, true);
  return () => {
    resize.disconnect();
    mutations.disconnect();
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("toggle", onToggle, true);
    owner.removeAttribute(PAGE_TITLE_CONTROLLER_ATTRIBUTE);
  };
};
