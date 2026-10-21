import { query } from "@k2b/stdlib/solid";
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { type Overview, OverviewSchema } from "../../overview-contracts";
import { jsonFetch } from "../http";
import { installPeriodicRefresh } from "./periodic-refresh";
import type { PulseWorkspaceProps } from "./types";

export class OverviewReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type OverviewPage = { attentionOffset?: number; activityCursor?: string };
export const readOverviewPage = async (baseId: string, page: OverviewPage, signal: AbortSignal): Promise<Overview> => {
  const params = new URLSearchParams();
  if (page.attentionOffset !== undefined) params.set("attentionOffset", String(page.attentionOffset));
  if (page.activityCursor !== undefined) params.set("activityCursor", page.activityCursor);
  const body = await jsonFetch<unknown>(
    `/api/pulse/bases/${encodeURIComponent(baseId)}/overview${params.size ? `?${params}` : ""}`,
    { signal },
    "REQUEST_FAILED",
    (status, body) =>
      new OverviewReadError(
        status === 401 || status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "REQUEST_FAILED",
        body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "REQUEST_FAILED",
      ),
  );
  return OverviewSchema.parse(body);
};
const denied = (error: { code: string } | null) => error?.code === "FORBIDDEN" || error?.code === "NOT_FOUND";
const failure = (error: unknown) => ({
  code: error instanceof OverviewReadError ? error.code : "REQUEST_FAILED",
  message: error instanceof Error ? error.message : "REQUEST_FAILED",
});

/** One authorized read owns all displayed facts; page reads cannot revive a revoked or replaced snapshot. */
export function createOverviewController(options: {
  baseId: string;
  active: Accessor<boolean>;
  initial?: PulseWorkspaceProps["initialOverview"];
  read?: typeof readOverviewPage;
}) {
  const read = options.read ?? readOverviewPage;
  const [initialError, setInitialError] = createSignal(options.initial?.error ?? null);
  const [pageError, setPageError] = createSignal<ReturnType<typeof failure> | null>(null);
  const [pages, setPages] = createSignal<{ snapshot: Overview; attention?: Overview["attention"]; activity?: Overview["activity"] } | null>(
    null,
  );
  const [paging, setPaging] = createSignal(false);
  // Revocation remains latched during retries, until a fresh authorized read succeeds.
  const [accessLost, setAccessLost] = createSignal(denied(options.initial?.error ?? null));
  let pageRequest: AbortController | null = null;
  let generation = 0;
  let disposed = false;
  let attentionPages = 1;
  let activityPages = 1;
  const snapshot = query.create({
    source: () => options.baseId,
    enabled: () => options.active() && !initialError(),
    initial: options.initial?.data ? { source: options.baseId, data: options.initial.data } : undefined,
    load: async (baseId, { abortSignal }) => {
      ++generation;
      pageRequest?.abort();
      setPaging(false);
      setPageError(null);
      // Refresh only the extent the reader already opened, never walk to exhaustion.
      // Publish it atomically, so failed refreshes retain every last-good row.
      const extent = { attention: attentionPages, activity: activityPages };
      try {
        let value = await read(baseId, {}, abortSignal);
        let attentionCount = 1;
        let activityCount = 1;
        while (attentionCount < extent.attention && value.attention.nextOffset !== null) {
          abortSignal.throwIfAborted();
          const next = await read(baseId, { attentionOffset: value.attention.nextOffset }, abortSignal);
          value = {
            ...value,
            attention: {
              ...next.attention,
              items: [...new Map([...value.attention.items, ...next.attention.items].map((item) => [item.id, item])).values()],
            },
          };
          ++attentionCount;
        }
        while (activityCount < extent.activity && value.activity.nextCursor !== null) {
          abortSignal.throwIfAborted();
          const next = await read(baseId, { activityCursor: value.activity.nextCursor }, abortSignal);
          value = {
            ...value,
            activity: {
              ...next.activity,
              items: [...new Map([...value.activity.items, ...next.activity.items].map((item) => [item.id, item])).values()],
            },
          };
          ++activityCount;
        }
        if (!abortSignal.aborted && !disposed) {
          attentionPages = attentionCount;
          activityPages = activityCount;
          setAccessLost(false);
        }
        return value;
      } catch (error) {
        if (!abortSignal.aborted && !disposed && denied(failure(error))) {
          setAccessLost(true);
          setPages(null);
          attentionPages = activityPages = 1;
        }
        throw error;
      }
    },
  });
  const error = createMemo(() => initialError() ?? pageError() ?? (snapshot.error() ? failure(snapshot.error()) : null));
  const data = createMemo((): Overview | null => {
    const value = snapshot.data();
    if (!value || accessLost() || denied(error())) return null;
    const extra = pages();
    return extra?.snapshot === value
      ? { ...value, attention: extra.attention ?? value.attention, activity: extra.activity ?? value.activity }
      : value;
  });
  const refresh = async () => {
    setInitialError(null);
    await snapshot.refresh();
    if (snapshot.error()) throw snapshot.error();
  };
  const periodic = installPeriodicRefresh({ active: options.active, intervalMs: 60_000, refresh });
  const loadPage = async (kind: "attention" | "activity") => {
    const current = data();
    const owner = snapshot.data();
    if (!current || !owner || paging() || snapshot.loading() || snapshot.refreshing()) return;
    const page: OverviewPage = {};
    if (kind === "attention") {
      if (current.attention.nextOffset === null) return;
      page.attentionOffset = current.attention.nextOffset;
    } else {
      if (current.activity.nextCursor === null) return;
      page.activityCursor = current.activity.nextCursor;
    }
    const epoch = generation;
    pageRequest = new AbortController();
    const request = pageRequest;
    setPaging(true);
    setPageError(null);
    try {
      const next = await read(options.baseId, page, request.signal);
      if (request.signal.aborted || disposed || generation !== epoch || snapshot.data() !== owner) return;
      // Stable IDs prevent duplicate rows if new activity arrives between pages.
      if (kind === "attention") {
        const items = [...new Map([...current.attention.items, ...next.attention.items].map((item) => [item.id, item])).values()];
        setPages((previous) => ({
          ...(previous?.snapshot === owner ? previous : null),
          snapshot: owner,
          attention: { ...next.attention, items },
        }));
        ++attentionPages;
      } else {
        const items = [...new Map([...current.activity.items, ...next.activity.items].map((item) => [item.id, item])).values()];
        setPages((previous) => ({
          ...(previous?.snapshot === owner ? previous : null),
          snapshot: owner,
          activity: { ...next.activity, items },
        }));
        ++activityPages;
      }
    } catch (error) {
      if (!request.signal.aborted && !disposed && generation === epoch) {
        const value = failure(error);
        if (denied(value)) {
          setAccessLost(true);
          setPages(null);
          attentionPages = activityPages = 1;
        }
        setPageError(value);
      }
    } finally {
      if (pageRequest === request) {
        pageRequest = null;
        setPaging(false);
      }
    }
  };
  onCleanup(() => {
    disposed = true;
    ++generation;
    pageRequest?.abort();
  });
  return {
    data,
    error,
    accessLost,
    paging,
    loading: snapshot.loading,
    refreshing: snapshot.refreshing,
    refresh,
    retry: periodic.retry,
    loadAttention: () => void loadPage("attention"),
    loadActivity: () => void loadPage("activity"),
  };
}
