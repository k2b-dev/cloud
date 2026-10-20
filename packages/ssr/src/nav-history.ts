import type { EnhancedNavigateOptions, PopStateNavigationEvent, ScrollSnapshot } from "./nav";

const SCROLL_PRESERVE_SELECTOR = "[data-scroll-preserve]";

/** Where an installed page swap keeps its per-document state (see nav-swap.ts). */
export const swapKey = Symbol.for("@k2b/ssr/nav-swap");

type SharedSwap = typeof globalThis & {
  [swapKey]?: {
    active?: AbortController;
    started: number;
    decide: (event: PopStateEvent) => "page" | "nav";
    stopRestore: () => void;
  };
};

/** Any newer navigation wins over a pending page swap and a pending reload scroll replay. Without an installed swap this does nothing. */
export const cancelPageSwap = (): void => {
  const shared: SharedSwap = globalThis;
  shared[swapKey]?.stopRestore();
  shared[swapKey]?.active?.abort();
};

/**
 * Returns a check that turns true once a page swap starts after this call: that swap is the newer navigation, so
 * deferred work of this one must not change history. Without an installed swap the check stays false.
 */
export const swapOvertakes = (): (() => boolean) => {
  const shared: SharedSwap = globalThis;
  const swap = shared[swapKey];
  const started = swap?.started;
  return () => swap !== undefined && swap.started !== started;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => unknown;
};

/**
 * Returns the current URL path + query, without the hash.
 */
export const currentPathWithQuery = (): string => {
  const url = new URL(window.location.href);
  return `${url.pathname}${url.search}`;
};

/**
 * Navigates to the current path + query with a full document navigation.
 */
export const refreshCurrentPath = (): void => {
  cancelPageSwap();
  window.location.assign(currentPathWithQuery());
};

/**
 * Navigates with a full document navigation.
 */
export const navigateTo = (href: string): void => {
  cancelPageSwap();
  window.location.assign(href);
};

export const startViewTransition = (callback: () => void | Promise<void>): void => {
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition) {
    void callback();
    return;
  }
  doc.startViewTransition(callback);
};

const restoreRegionScroll = (snapshot: ScrollSnapshot): void => {
  for (const region of snapshot.regions) {
    const selector = `[data-scroll-preserve="${CSS.escape(region.key)}"]`;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    el.scrollLeft = region.x;
    el.scrollTop = region.y;
  }
};

/**
 * Captures window scroll and keyed `[data-scroll-preserve]` regions.
 */
export const captureScroll = (selector = SCROLL_PRESERVE_SELECTOR): ScrollSnapshot => ({
  window: { x: window.scrollX, y: window.scrollY },
  regions: Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((el) => ({
      key: el.dataset.scrollPreserve ?? "",
      x: el.scrollLeft,
      y: el.scrollTop,
    }))
    .filter((region) => region.key.length > 0),
});

/**
 * Restores a captured scroll snapshot.
 */
export const restoreScroll = (snapshot: ScrollSnapshot, options: { window?: boolean } = {}): void => {
  restoreRegionScroll(snapshot);
  if (options.window === false) return;
  window.scrollTo(snapshot.window.x, snapshot.window.y);
};

/**
 * Subscribes to browser Back/Forward within the shown page when page swaps are installed.
 *
 * The application remains responsible for reconciling its island state with
 * the URL. This helper intentionally does not perform route matching.
 */
export const listenPopState = (handler: (navigation: PopStateNavigationEvent) => void): (() => void) => {
  const listener = (event: PopStateEvent) => {
    const shared: SharedSwap = globalThis;
    if (shared[swapKey]?.decide(event) === "nav") return;
    handler({ event, url: new URL(window.location.href), state: event.state });
  };

  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};

export const resolveNavigationUrl = (href: string): URL => new URL(href, document.baseURI || window.location.href);

/**
 * Updates browser history without a document reload.
 *
 * Use this after the current island has already updated its UI or when it is
 * intentionally preserving the current DOM. It does not match routes, load
 * data, or re-render server pages.
 */
export const navigate = (href: string, options: EnhancedNavigateOptions = {}): void => {
  cancelPageSwap();
  const overtaken = swapOvertakes();
  const url = resolveNavigationUrl(href);
  if (url.origin !== window.location.origin) {
    documentNavigate(url.href, { replace: options.replace });
    return;
  }

  const scroll = options.scroll ?? "top";
  const snapshot = scroll === "manual" ? null : (options.scrollSnapshot ?? captureScroll());
  const target = `${url.pathname}${url.search}${url.hash}`;

  const commit = () => {
    // A view transition defers this commit; a swap started meanwhile is the newer navigation.
    if (overtaken()) return;
    const hasExplicitState = Object.prototype.hasOwnProperty.call(options, "state");
    const state = hasExplicitState ? options.state : options.replace ? window.history.state : null;

    if (options.replace) window.history.replaceState(state, "", target);
    else window.history.pushState(state, "", target);

    if (!snapshot) return;
    restoreRegionScroll(snapshot);
    if (scroll === "preserve") {
      window.scrollTo(snapshot.window.x, snapshot.window.y);
      return;
    }
    window.scrollTo(0, 0);
  };

  if (options.viewTransition === false) {
    commit();
    return;
  }
  startViewTransition(commit);
};

export const documentNavigate = (href: string, options: { replace?: boolean } = {}): void => {
  cancelPageSwap();
  if (options.replace) window.location.replace(href);
  else window.location.assign(href);
};
