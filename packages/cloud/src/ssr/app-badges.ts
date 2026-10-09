import { createSignal } from "solid-js";
import { APP_BADGES_REFRESH_EVENT } from "../browser/app-badges";

/**
 * Shortest time between two scheduled reads in one tab. Badges are a hint to
 * open an app, not a live view, so one read per minute keeps them current
 * while someone works elsewhere without a steady stream of requests per tab.
 */
export const APP_BADGE_INTERVAL_MS = 60_000;

// Keyed by endpoint, so a pinned app shortcut and the app's own entry share one
// count. Only the browser ever writes it; server renders always see no badge.
const [counts, setCounts] = createSignal<ReadonlyMap<string, number>>(new Map());

/** The count for a declared `nav.badge` endpoint; 0 until the browser has read it. */
export const appBadgeCount = (endpoint: string | undefined): number => (endpoint ? (counts().get(endpoint) ?? 0) : 0);

/** A positive safe integer from an `AppNavBadge` body, else 0. */
export const parseAppBadge = (body: unknown): number => {
  if (typeof body !== "object" || body === null || !("count" in body)) return 0;
  const count = body.count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
};

const readBadge = async (endpoint: string, signal: AbortSignal): Promise<number> => {
  try {
    const response = await fetch(endpoint, { credentials: "same-origin", headers: { accept: "application/json" }, signal });
    return response.status === 200 ? parseAppBadge(await response.json()) : 0;
  } catch {
    // An unreachable or failing app shows no badge rather than a stale one.
    return 0;
  }
};

let watching = false;

/**
 * Reads the badge endpoints after hydration, when a hidden tab becomes visible
 * again after the interval, every interval while visible, and on
 * `refreshAppBadges()`. A hidden tab sends nothing. At most one read per
 * endpoint is in flight; a newer read cancels it. Returns a disposer.
 */
export const watchAppBadges = (endpoints: readonly string[]): (() => void) => {
  const unique = [...new Set(endpoints)];
  if (typeof window === "undefined" || unique.length === 0 || watching) return () => {};
  watching = true;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = Number.NEGATIVE_INFINITY;

  const refresh = () => {
    clearTimeout(timer);
    timer = undefined;
    if (document.visibilityState === "hidden") return;
    last = Date.now();
    timer = setTimeout(refresh, APP_BADGE_INTERVAL_MS);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    void Promise.all(unique.map(async (endpoint) => [endpoint, await readBadge(endpoint, current.signal)] as const)).then((entries) => {
      if (!current.signal.aborted) setCounts(new Map(entries));
    });
  };
  const resume = () => {
    if (document.visibilityState !== "hidden" && Date.now() - last >= APP_BADGE_INTERVAL_MS) refresh();
  };

  document.addEventListener("visibilitychange", resume);
  window.addEventListener(APP_BADGES_REFRESH_EVENT, refresh);
  refresh();
  return () => {
    watching = false;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener(APP_BADGES_REFRESH_EVENT, refresh);
  };
};
