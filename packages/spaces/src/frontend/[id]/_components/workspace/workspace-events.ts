export const SPACES_DETAIL_NAVIGATION_EVENT = "spaces-detail-navigation";
export const SPACES_DETAIL_STATE_EVENT = "spaces-detail-state";
export const SPACES_DATA_INVALIDATED_EVENT = "spaces-data-invalidated";

export type SpacesDetailNavigation = {
  href: string;
  itemId: string | null;
  occurrenceId: string | null;
  history?: "push" | "replace" | "none";
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

export const createSpacesLiveCursorQueue = (options: {
  invalidate: (domains: SpacesDataDomain[], cursor: string | null, itemId: string | null) => Promise<void>;
  markApplied: (cursor: string | null) => void;
  onFailure: (error: Error) => void;
}) => {
  let queue = Promise.resolve();
  let failed = false;

  return (domains: SpacesDataDomain[], cursor: string | null, itemId: string | null = null) => {
    queue = queue
      .then(async () => {
        if (failed) return;
        await options.invalidate(domains, cursor, itemId);
        if (!failed) options.markApplied(cursor);
      })
      .catch((error) => {
        if (failed) return;
        failed = true;
        options.onFailure(error instanceof Error ? error : new Error(String(error)));
      });
    return queue;
  };
};

export const subscribeToSpacesDataInvalidation = (
  domains: SpacesDataDomain[],
  invalidate: (invalidation: { cursor: string | null; itemId: string | null }) => Promise<void>,
) => {
  const onInvalidated = (event: Event) => {
    const detail = (event as CustomEvent<SpacesDataInvalidation>).detail;
    if (!detail || !domains.some((domain) => detail.domains.includes(domain))) return;
    detail.cover(invalidate({ cursor: detail.cursor, itemId: detail.itemId }));
  };
  window.addEventListener(SPACES_DATA_INVALIDATED_EVENT, onInvalidated);
  return () => window.removeEventListener(SPACES_DATA_INVALIDATED_EVENT, onInvalidated);
};

const publishDetailNavigation = (target: URL, history: "push" | "replace" | "none") => {
  window.dispatchEvent(
    new CustomEvent<SpacesDetailNavigation>(SPACES_DETAIL_NAVIGATION_EVENT, {
      detail: {
        href: `${target.pathname}${target.search}`,
        itemId: target.searchParams.get("item"),
        occurrenceId: target.searchParams.get("occurrence"),
        history,
      },
    }),
  );
};

/** Reconciles the detail island after another controller has already committed browser history. */
export const reconcileSpacesDetailRoute = (href: string) => {
  publishDetailNavigation(new URL(href, window.location.origin), "none");
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
