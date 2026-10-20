/**
 * The way up, in the browser: links in a page trail lead to the page above,
 * as this tab left it. A plain up link would reset the list a person
 * filtered, searched, and scrolled; this runtime remembers each page's last
 * URL and scroll position per tab and returns there. The trail's links keep
 * their canonical `href`, so a new tab, a copied link, or a reload still lead
 * to the page itself. After returning, the row that led down is marked.
 */

import { swapPage } from "@k2b/ssr/nav";
import { PAGE_TRAIL_EVENT, readPageTrail } from "@k2b/ui";
import { registerContextAwareCommand } from "../browser/command-bridge";
import { PAGE_UP_EVENT, type PageUpDetail } from "./layout-runtime";

const STORAGE_KEY = "cloud:page-trail";
/**
 * Recent pages per tab. A trail goes back through a few levels, often across
 * a detour into another app; thirty distinct pages cover that with room to
 * spare while the memory stays a few kilobytes of `sessionStorage`.
 */
const VISIT_LIMIT = 30;
/** How long a returning page may take to render the regions and rows it restores, at one try per frame. */
const RESTORE_FRAMES = 60;
const TRAIL_LINK = "a[data-k2b-page-trail-link]";
const MAIN = ".layout-content-main";

type Region = { key: string; top: number; left: number };
/** A page as this tab left it; `up` holds the links of the levels above it then. */
type Visit = { url: string; regions: Region[]; up?: string[] };
type Memory = { visits: Visit[]; returning?: { url: string; from: string } };

/**
 * `path` as a page of this origin, or nothing: read against the origin,
 * `//host`, `@host`, or `javascript:` would lead elsewhere, and a path that
 * parses to `//host`, such as `/..//host`, would once an island reads its
 * pathname.
 */
const localPage = (path: string): URL | undefined => {
  if (!path.startsWith("/")) return undefined;
  try {
    const url = new URL(path, location.origin);
    return url.origin === location.origin && !url.pathname.startsWith("//") ? url : undefined;
  } catch {
    return undefined;
  }
};

const isRegion = (value: unknown): value is Region =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  typeof value.key === "string" &&
  "top" in value &&
  typeof value.top === "number" &&
  "left" in value &&
  typeof value.left === "number";

/**
 * The tab's storage is not trusted: a visit or a return counts only when its
 * addresses are pages of this origin and the rest has the shape this runtime writes.
 */
const isVisit = (value: unknown): value is Visit =>
  typeof value === "object" &&
  value !== null &&
  "url" in value &&
  typeof value.url === "string" &&
  localPage(value.url) !== undefined &&
  "regions" in value &&
  Array.isArray(value.regions) &&
  value.regions.every(isRegion) &&
  (!("up" in value) ||
    (Array.isArray(value.up) && value.up.every((item: unknown) => typeof item === "string" && URL.canParse(item, location.href))));

const isReturning = (value: unknown): value is NonNullable<Memory["returning"]> =>
  typeof value === "object" &&
  value !== null &&
  "url" in value &&
  typeof value.url === "string" &&
  localPage(value.url) !== undefined &&
  "from" in value &&
  typeof value.from === "string" &&
  localPage(value.from) !== undefined;

const read = (): Memory => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (value !== null && typeof value === "object" && "visits" in value && Array.isArray(value.visits)) {
      const visits = value.visits.filter(isVisit);
      return "returning" in value && isReturning(value.returning) ? { visits, returning: value.returning } : { visits };
    }
  } catch {
    // A full or blocked storage only costs the memory, never the navigation.
  }
  return { visits: [] };
};
const write = (memory: Memory) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // See `read`.
  }
};

const here = () => `${location.pathname}${location.search}${location.hash}`;
const pathOf = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
const resolve = (href: string) => new URL(href, location.href);

/** A remembered page is the page `target` names when it has the same path and every query value `target` sets. */
const isPage = (visited: URL, target: URL) =>
  visited.origin === target.origin &&
  pathOf(visited) === pathOf(target) &&
  [...target.searchParams].every(([key, value]) => visited.searchParams.getAll(key).includes(value));
/** How many of `from`'s query values `url` carries, less the ones the two do not share. */
const queryMatch = (url: URL, from: URL) => {
  const shared = [...url.searchParams].filter(([key, value]) => from.searchParams.getAll(key).includes(value)).length;
  return 2 * shared - ([...url.searchParams].length - shared) - ([...from.searchParams].length - shared);
};

/** The page's scroll positions: the window, the shell's page scroller, and every keyed `data-scroll-preserve` region. */
const captureRegions = (): Region[] => {
  const regions: Region[] = [{ key: "@window", top: window.scrollY, left: window.scrollX }];
  const main = document.querySelector<HTMLElement>(MAIN);
  if (main) regions.push({ key: "@main", top: main.scrollTop, left: main.scrollLeft });
  for (const element of document.querySelectorAll<HTMLElement>("[data-scroll-preserve]")) {
    const key = element.dataset.scrollPreserve;
    if (key) regions.push({ key, top: element.scrollTop, left: element.scrollLeft });
  }
  return regions.filter((region) => region.top || region.left);
};

/** Remembers the page as it is now, newest first, with the levels above it. */
export const rememberPage = () => {
  const memory = read();
  const url = here();
  const up = readPageTrail()?.ancestors.map((level) => level.href) ?? [];
  memory.visits = [{ url, regions: captureRegions(), up }, ...memory.visits.filter((visit) => visit.url !== url)].slice(0, VISIT_LIMIT);
  write(memory);
};

/**
 * Where an up link leads in this tab: the page's last URL here, or its own
 * `href`. A page below the target is never that page, even when its address
 * carries the target's query, as a Files document carries its folder's: it
 * names the target as a level above it.
 */
export const upDestination = (href: string): string => {
  const target = resolve(href);
  const below = (visit: Visit) => (visit.up ?? []).some((level) => isPage(resolve(level), target) && isPage(target, resolve(level)));
  const visit = read().visits.find((candidate) => isPage(resolve(candidate.url), target) && !below(candidate));
  return visit?.url ?? `${target.pathname}${target.search}${target.hash}`;
};

/**
 * Goes one or more levels up to `href`, back to how this tab left that page.
 * An island that navigates in place takes the way up itself (see
 * `layout.handleUp`); otherwise the page loads. Returns whether it took the
 * way up; a link it does not take stays a plain link.
 */
export const goUp = (href: string): boolean => {
  // The way up stays on this origin; a link elsewhere, such as `javascript:`, names no page above.
  if (resolve(href).origin !== location.origin) return false;
  rememberPage();
  const destination = upDestination(href);
  // The destination is read as a path of this origin and must stay there; one that starts with `//` names another host.
  const url = localPage(destination);
  if (!url) return false;
  const detail: PageUpDetail = { href: destination };
  if (!window.dispatchEvent(new CustomEvent(PAGE_UP_EVENT, { cancelable: true, detail }))) return true;
  const memory = read();
  memory.returning = { url: destination, from: here() };
  write(memory);
  const canvas = document.querySelector<HTMLElement>(".cloud-app-canvas[data-nav-shell]");
  const scope = canvas?.dataset.navScope;
  if (scope && url.origin === location.origin && (url.pathname === scope || url.pathname.startsWith(`${scope}/`))) void swapPage(url.href);
  else location.assign(url.href);
  return true;
};

const regionElement = (key: string): HTMLElement | null =>
  key === "@main"
    ? document.querySelector<HTMLElement>(MAIN)
    : document.querySelector<HTMLElement>(`[data-scroll-preserve="${CSS.escape(key)}"]`);

/** Scores of links to the page itself rank above every link to a page above it, which score by path length. */
const SAME_PAGE = 1_000_000;

/**
 * The link on this page that led towards `from`: the same page, or, for
 * nested paths, the nearest page above it. Navigation, the rail, and trails
 * themselves lead elsewhere and do not count.
 */
const rowTowards = (from: URL): HTMLElement | null => {
  const scope = document.querySelector(MAIN) ?? document.body;
  let best: { element: HTMLAnchorElement; score: number } | null = null;
  for (const link of scope.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.closest(".k2b-page-title, .k2b-app-workspace__sidebar, .layout-rail, nav")) continue;
    const url = resolve(link.getAttribute("href") ?? "");
    if (url.origin !== from.origin) continue;
    // The row may carry the list's query or leave it out; either way it names the same page. The closer its query
    // is to `from`'s, the surer it is the row: a link without one, such as "All things", only names the list.
    const same = isPage(from, url) || isPage(url, from);
    const above = !same && url.search === "" && pathOf(from).startsWith(`${pathOf(url)}/`);
    if (!same && !above) continue;
    const score = same ? SAME_PAGE + queryMatch(url, from) : pathOf(url).length;
    if (!best || score > best.score) best = { element: link, score };
  }
  return best ? (best.element.closest<HTMLElement>("tr, [role='row'], li") ?? best.element) : null;
};

/** Restores a returning page's scroll positions and marks the row that led down. Islands render late, so it retries per frame. */
const restoreReturn = (visit: Visit | undefined, from: URL) => {
  const pending = new Map((visit?.regions ?? []).map((region) => [region.key, region]));
  let marked: HTMLElement | null = null;
  let frames = 0;
  const step = () => {
    for (const [key, region] of pending) {
      // A region is restored once both axes hold; content that renders late can still widen or lengthen it.
      if (key === "@window") {
        window.scrollTo(region.left, region.top);
        if (Math.abs(window.scrollY - region.top) < 1 && Math.abs(window.scrollX - region.left) < 1) pending.delete(key);
        continue;
      }
      const element = regionElement(key);
      if (!element) continue;
      element.scrollTop = region.top;
      element.scrollLeft = region.left;
      if (Math.abs(element.scrollTop - region.top) < 1 && Math.abs(element.scrollLeft - region.left) < 1) pending.delete(key);
    }
    if (!marked?.isConnected) {
      marked = rowTowards(from);
      if (marked) {
        marked.setAttribute("data-page-trail-recent", "");
        if (!visit?.regions.length) marked.scrollIntoView({ block: "nearest" });
      }
    }
    frames += 1;
    if (frames < RESTORE_FRAMES && (pending.size || !marked)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** The localized name and description of the "One level up" command for a parent page. */
export type PageUpLabels = (parent: string) => { title: string; description: string };

/**
 * Offers "One level up" (Alt+↑, ⌥↑ on a Mac) while the page has a page above
 * it, through the shared command system: the shortcut, the palette, and the
 * shortcut help list it only then, and the shortcut stays quiet in text
 * fields. It follows trail changes from `layout.update()`.
 */
const offerPageUp = (labels: PageUpLabels): (() => void) => {
  let unregister = () => {};
  const update = () => {
    unregister();
    unregister = () => {};
    const parent = readPageTrail()?.ancestors.at(-1);
    if (!parent) return;
    unregister = registerContextAwareCommand({
      id: "cloud.page-up",
      ...labels(parent.title),
      icon: "ti ti-arrow-up",
      shortcut: "alt+arrowup",
      action: () => {
        goUp(parent.href);
      },
    });
  };
  update();
  window.addEventListener(PAGE_TRAIL_EVENT, update);
  window.addEventListener("ssr:nav-swapped", update);
  return () => {
    window.removeEventListener(PAGE_TRAIL_EVENT, update);
    window.removeEventListener("ssr:nav-swapped", update);
    unregister();
  };
};

/**
 * Installs the runtime for the document. Every click and Enter remembers the
 * page as it is before anything navigates, also in place, as a list row that
 * opens on Enter does; a plain click on a trail link goes up through the
 * memory. Returns the disposer.
 */
export const installPageTrailRuntime = (labels: PageUpLabels): (() => void) => {
  const stopPageUp = offerPageUp(labels);
  const restoreArrivingPage = () => {
    const memory = read();
    const returning = memory.returning;
    if (returning) {
      delete memory.returning;
      write(memory);
      const current = resolve(here());
      if (pathOf(resolve(returning.url)) === pathOf(current) && resolve(returning.url).search === current.search)
        restoreReturn(
          memory.visits.find((visit) => visit.url === returning.url),
          resolve(returning.from),
        );
    }
  };
  restoreArrivingPage();
  window.addEventListener("ssr:nav-swapped", restoreArrivingPage);
  const onCapture = () => rememberPage();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") rememberPage();
  };
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>(TRAIL_LINK);
    if (!link || (link.target && link.target !== "_self")) return;
    if (goUp(link.href)) event.preventDefault();
  };
  document.addEventListener("click", onCapture, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onClick);
  window.addEventListener("pagehide", onCapture);
  return () => {
    window.removeEventListener("ssr:nav-swapped", restoreArrivingPage);
    stopPageUp();
    document.removeEventListener("click", onCapture, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onClick);
    window.removeEventListener("pagehide", onCapture);
  };
};
