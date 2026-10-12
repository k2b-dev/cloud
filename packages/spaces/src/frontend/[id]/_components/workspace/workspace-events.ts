export const SPACES_DETAIL_NAVIGATION_EVENT = "spaces-detail-navigation";
export const SPACES_DETAIL_STEP_EVENT = "spaces-detail-step";
export const SPACES_DETAIL_STATE_EVENT = "spaces-detail-state";
export const SPACES_DATA_INVALIDATED_EVENT = "spaces-data-invalidated";

export type SpacesDetailNavigation = {
  href: string;
  itemId: string | null;
  occurrenceId: string | null;
  history?: "push" | "replace" | "none";
  reconcile?: true;
};

export type SpacesDetailState = {
  itemId: string | null;
  occurrenceId: string | null;
  selectionId: string | null;
};

export type SpacesDataDomain = "view" | "detail" | "wormholes";
export type SpacesDataInvalidation = {
  domains: SpacesDataDomain[];
  cursor: string | null;
  itemId: string | null;
  cover: (promise: Promise<void>) => void;
};

const routeKeyWithoutItem = (url: URL) => {
  const params = new URLSearchParams(url.search);
  params.delete("item");
  params.delete("occurrence");
  params.sort();
  return `${url.pathname}?${params.toString()}`;
};

export const resolveCalendarNavigationHref = (href: string, origin: string, expectedPath: string): string | null => {
  try {
    const target = new URL(href, origin);
    if (target.origin !== origin || target.pathname !== expectedPath) return null;
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
};

export const isDetailOnlySpacesNavigation = (currentHref: string, targetHref: string, origin: string) => {
  const current = new URL(currentHref, origin);
  const target = new URL(targetHref, origin);
  return target.origin === current.origin && routeKeyWithoutItem(target) === routeKeyWithoutItem(current);
};

export const publishSpacesDetailState = (detail: SpacesDetailState) => {
  window.dispatchEvent(new CustomEvent<SpacesDetailState>(SPACES_DETAIL_STATE_EVENT, { detail }));
};

export const shouldInvalidateSpacesDetail = (selectedItemId: string | null, invalidatedItemId: string | null) =>
  invalidatedItemId === null || selectedItemId === invalidatedItemId;

export const invalidateSpacesData = (
  domains: SpacesDataDomain[] = ["view", "detail"],
  cursor: string | null = null,
  itemId: string | null = null,
) => {
  const coverage: Promise<void>[] = [];
  const detail: SpacesDataInvalidation = {
    domains,
    cursor,
    itemId,
    cover: (promise) => coverage.push(promise),
  };
  window.dispatchEvent(new CustomEvent<SpacesDataInvalidation>(SPACES_DATA_INVALIDATED_EVENT, { detail }));
  return Promise.all(coverage).then(() => undefined);
};

export const subscribeToSpacesDataInvalidation = (
  domains: SpacesDataDomain[],
  invalidate: (invalidation: { cursor: string | null; itemId: string | null }) => Promise<void>,
) => {
  let subscribed = true;
  const onInvalidated = (event: Event) => {
    const detail = (event as CustomEvent<SpacesDataInvalidation>).detail;
    if (!detail || !domains.some((domain) => detail.domains.includes(domain))) return;
    // A query disposed during its refresh (a board column rebuilt from the new
    // snapshot, a detail that closed) no longer shows data, so its rejection
    // leaves nothing uncovered.
    detail.cover(
      // Preserve event identity so subscribers can share work for this invalidation.
      invalidate(detail).catch((error: unknown) => {
        if (subscribed) throw error;
      }),
    );
  };
  window.addEventListener(SPACES_DATA_INVALIDATED_EVENT, onInvalidated);
  return () => {
    subscribed = false;
    window.removeEventListener(SPACES_DATA_INVALIDATED_EVENT, onInvalidated);
  };
};

const publishDetailNavigation = (target: URL, history: "push" | "replace" | "none", reconcile?: true) => {
  window.dispatchEvent(
    new CustomEvent<SpacesDetailNavigation>(SPACES_DETAIL_NAVIGATION_EVENT, {
      detail: {
        href: `${target.pathname}${target.search}`,
        itemId: target.searchParams.get("item"),
        occurrenceId: target.searchParams.get("occurrence"),
        history,
        reconcile,
      },
    }),
  );
};

/** Reconciles the detail island after another controller has already committed browser history. */
export const reconcileSpacesDetailRoute = (href: string) => {
  publishDetailNavigation(new URL(href, window.location.origin), "none", true);
};

/**
 * Enhances item-only URL changes. Every other route keeps a real document
 * navigation so the server remains the owner of shell and sidebar state.
 */
export const requestSpacesRouteNavigation = (href: string, options: { replace?: boolean; scroll?: unknown } = {}) => {
  const current = new URL(window.location.href);
  const target = new URL(href, window.location.origin);
  if (isDetailOnlySpacesNavigation(current.href, target.href, current.origin)) {
    publishDetailNavigation(target, options.replace ? "replace" : "push");
    return;
  }

  if (options.replace) window.location.replace(`${target.pathname}${target.search}`);
  else window.location.assign(`${target.pathname}${target.search}`);
};

/**
 * Opens the item a link names in the detail of the page as it stands. A view that keeps its own place in the URL,
 * such as the calendar's day while the reader scrolls, links items from a place it may have left since.
 */
export const requestSpacesDetailNavigation = (href: string, options: { replace?: boolean; scroll?: unknown } = {}) => {
  const target = new URL(href, window.location.origin);
  const current = new URL(window.location.href);
  for (const key of ["item", "occurrence"]) {
    const value = target.searchParams.get(key);
    if (value === null) current.searchParams.delete(key);
    else current.searchParams.set(key, value);
  }
  requestSpacesRouteNavigation(`${current.pathname}${current.search}`, options);
};

/** J or K in the open detail; the view that shows the items answers with the link it opened in `target`. */
export type SpacesDetailStep = {
  direction: 1 | -1;
  itemId: string | null;
  occurrenceId: string | null;
  target?: HTMLAnchorElement;
};

/** Asks the current view for the next or previous visible item and returns the link it opened, if any. */
export const requestSpacesDetailStep = (direction: 1 | -1, selection: { itemId: string | null; occurrenceId: string | null }) => {
  const detail: SpacesDetailStep = { direction, ...selection };
  window.dispatchEvent(new CustomEvent<SpacesDetailStep>(SPACES_DETAIL_STEP_EVENT, { detail }));
  return detail.target;
};

/**
 * Steps through a view's visible item links in DOM order, without wrapping and only through loaded items. A
 * selection the view does not show starts at its first or last link. The step replaces the history entry, so Back
 * leaves the detail instead of replaying every step. Clicks remember the selected copy of duplicate items.
 */
export const subscribeToSpacesDetailStep = (links: () => HTMLAnchorElement[], opened?: (link: HTMLAnchorElement) => void) => {
  let lastOpened: HTMLAnchorElement | undefined;
  const onClick = (event: Event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (anchor && links().includes(anchor)) lastOpened = anchor;
  };
  const onStep = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: SpacesDetailStep = event.detail;
    if (!detail || detail.target) return;
    const visible = links();
    const matching = visible.filter((link) => {
      const url = new URL(link.href, window.location.origin);
      return url.searchParams.get("item") === detail.itemId && url.searchParams.get("occurrence") === detail.occurrenceId;
    });
    const current =
      matching.find((link) => link.contains(document.activeElement)) ?? matching.find((link) => link === lastOpened) ?? matching[0];
    const index = current ? visible.indexOf(current) + detail.direction : detail.direction === 1 ? 0 : visible.length - 1;
    const next = visible[index];
    const href = next?.getAttribute("href");
    if (!next || !href) return;
    opened?.(next);
    requestSpacesRouteNavigation(href, { replace: true, scroll: "preserve" });
    lastOpened = next;
    detail.target = next;
  };
  window.addEventListener(SPACES_DETAIL_STEP_EVENT, onStep);
  document.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener(SPACES_DETAIL_STEP_EVENT, onStep);
    document.removeEventListener("click", onClick, true);
  };
};
