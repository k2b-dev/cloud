import { createSignal } from "solid-js";
import { APP_BADGES_REFRESH_EVENT } from "../browser/app-badges";
import { APPROVAL_COUNTS_PATH } from "../contracts/approval-paths";
import type { ApprovalCounts } from "../contracts/approvals";

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
// The line a Cloud app part's summary route returns beside its count, keyed like the counts.
const [texts, setTexts] = createSignal<ReadonlyMap<string, string>>(new Map());

/** The text of a `PwaPartSummary` route once the browser has read it; undefined before or when the read failed. */
export const appPartSummaryText = (endpoint: string): string | undefined => texts().get(endpoint);

const [approvalCounts, setApprovalCounts] = createSignal<ApprovalCounts | null>(null);

/** Retain an SSR count until the first browser read; a failed read still resolves to zero. */
export const liveApprovalCount = (appId?: string): number | null => {
  const current = approvalCounts();
  if (!current) return null;
  if (appId === undefined) return current.total;
  return Object.hasOwn(current.apps, appId) ? (current.apps[appId] ?? 0) : 0;
};
export const approvalCount = (appId?: string): number => liveApprovalCount(appId) ?? 0;

/** Endpoint and approval counts for one app; 0 until the browser has read them. */
export const appBadgeCount = (input: { endpoint?: string; appId?: string }): number =>
  (input.endpoint ? (counts().get(input.endpoint) ?? 0) : 0) + (input.appId ? approvalCount(input.appId) : 0);

/** A positive safe integer from an `AppNavBadge` body, else 0. */
export const parseAppBadge = (body: unknown): number => {
  if (typeof body !== "object" || body === null || !("count" in body)) return 0;
  const count = body.count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/** A one-line text of at most 200 characters from a `PwaPartSummary` body, else undefined. */
export const parsePartSummaryText = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null || !("text" in body)) return undefined;
  const text = body.text;
  return typeof text === "string" && text.trim() !== "" && text.length <= 200 && !/[\r\n]/.test(text) ? text.trim() : undefined;
};

type BadgeRead = { count: number; text?: string };

const readBadge = async (endpoint: string, signal: AbortSignal): Promise<BadgeRead> => {
  try {
    const response = await fetch(endpoint, { credentials: "same-origin", headers: { accept: "application/json" }, signal });
    if (response.status === 200) {
      const body: unknown = await response.json();
      return { count: parseAppBadge(body), text: parsePartSummaryText(body) };
    }
    // Release the response without buffering an unused, potentially unbounded error body.
    await response.body?.cancel();
    return { count: 0 };
  } catch {
    // An unreachable or failing app shows no badge rather than a stale one.
    return { count: 0 };
  }
};

const isCount = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

/** What `ApprovalCountsSchema` accepts from a JSON body, without loading validators into the shell; a test compares both. */
export const parseApprovalCounts = (body: unknown): ApprovalCounts | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (Object.keys(body).length !== 2 || !("total" in body) || !("apps" in body)) return null;
  const { total, apps } = body;
  if (!isCount(total, 0) || typeof apps !== "object" || apps === null || Array.isArray(apps)) return null;
  // Like Zod's record, ignore a `__proto__` key that JSON.parse keeps as an own property.
  const entries = Object.entries(apps).filter(([app]) => app !== "__proto__");
  return entries.every(([, count]) => isCount(count, 1)) ? { total, apps: Object.fromEntries(entries) } : null;
};

const readApprovalCounts = async (signal: AbortSignal): Promise<ApprovalCounts> => {
  try {
    const response = await fetch(APPROVAL_COUNTS_PATH, { credentials: "same-origin", headers: { accept: "application/json" }, signal });
    if (response.status === 200) {
      const parsed = parseApprovalCounts(await response.json());
      if (parsed) return parsed;
    } else {
      await response.body?.cancel();
    }
  } catch {
    // A failing read clears approval counts just like an app badge.
  }
  return { total: 0, apps: {} };
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
  const unique = [...new Set([...endpoints, APPROVAL_COUNTS_PATH])];
  if (typeof window === "undefined" || watching) return () => {};
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
    const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(APP_BADGE_INTERVAL_MS)]);
    const result = endpoint === APPROVAL_COUNTS_PATH ? readApprovalCounts(signal) : readBadge(endpoint, signal);
    void result.then((answer) => {
      if (stopped.signal.aborted) return;
      if ("count" in answer) {
        setCounts((previous) => new Map(previous).set(endpoint, answer.count));
        setTexts((previous) => {
          const next = new Map(previous);
          if (answer.text === undefined) next.delete(endpoint);
          else next.set(endpoint, answer.text);
          return next;
        });
      } else setApprovalCounts(answer);
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
