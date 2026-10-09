import { createSignal } from "solid-js";
import { APP_BADGES_REFRESH_EVENT } from "../browser/app-badges";

/**
 * Shortest time between two scheduled reads in one tab, and the longest one
 * read may take. Badges are a hint to open an app, not a live view, so one
 * read per minute keeps them current while someone works elsewhere without a
 * steady stream of requests per tab.
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
 * Reads the badge endpoints after hydration, every interval while the tab is
 * visible, when a hidden tab becomes visible again after the interval, and on
 * `refreshAppBadges()`. A hidden tab sends nothing and keeps its schedule.
 * Each endpoint has at most one read in flight, and its count shows as soon as
 * that read settles, so a slow app delays only its own badge. A refresh while
 * a read runs queues one more read after it instead of another request, and a
 * read still running after the interval gives up. Returns a disposer.
 */
export const watchAppBadges = (endpoints: readonly string[]): (() => void) => {
  const unique = [...new Set(endpoints)];
  if (typeof window === "undefined" || unique.length === 0 || watching) return () => {};
  watching = true;
  const stopped = new AbortController();
  // Endpoints with a read in flight, mapped to whether one more read waits for it.
  const running = new Map<string, boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = Number.NEGATIVE_INFINITY;

  const read = (endpoint: string) => {
    if (running.has(endpoint)) {
      running.set(endpoint, true);
      return;
    }
    running.set(endpoint, false);
    void readBadge(endpoint, AbortSignal.any([stopped.signal, AbortSignal.timeout(APP_BADGE_INTERVAL_MS)])).then((count) => {
      if (stopped.signal.aborted) return;
      setCounts((previous) => new Map(previous).set(endpoint, count));
      const queued = running.get(endpoint);
      running.delete(endpoint);
      if (queued && document.visibilityState !== "hidden") read(endpoint);
    });
  };
  const refresh = () => {
    // Leave the pending read in place, so the tab still reads on time once it is visible again.
    if (document.visibilityState === "hidden") return;
    clearTimeout(timer);
    last = Date.now();
    timer = setTimeout(refresh, APP_BADGE_INTERVAL_MS);
    for (const endpoint of unique) read(endpoint);
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
    stopped.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener(APP_BADGES_REFRESH_EVENT, refresh);
  };
};
