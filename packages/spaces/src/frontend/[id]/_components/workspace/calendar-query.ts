import { documentNavigate, listenPopState, navigate } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { prompts, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { parseCalendarRoute } from "../calendar/filter";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import { reconcileSpacesDetailRoute, resolveCalendarNavigationHref, subscribeToSpacesDataInvalidation } from "./workspace-events";
import type { SpacesViewSnapshot } from "./workspace-types";

type CalendarSnapshot = Extract<SpacesViewSnapshot, { kind: "calendar" }>;
type PendingNavigation = {
  id: number;
  href: string;
  source: string;
  history: "push" | "replace" | "popstate";
  started: boolean;
};

const pathWithQuery = (url: URL) => `${url.pathname}${url.search}`;
const calendarViewSource = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  url.searchParams.delete("item");
  url.searchParams.delete("occurrence");
  return pathWithQuery(url);
};

export const useSpacesCalendarQuery = (params: {
  spaceId: string;
  initialSource: string;
  initialSnapshot: CalendarSnapshot;
  dateConfig?: Parameters<typeof parseCalendarRoute>[1];
}) => {
  const locale = useLocale();
  const t = useSpaceMessages();
  const expectedPath = `/app/spaces/${params.spaceId}`;
  const normalize = (href: string) => resolveCalendarNavigationHref(href, window.location.origin, expectedPath);
  const [source, setSource] = createSignal(params.initialSource);
  const [preview, setPreview] = createSignal<CalendarSnapshot>(params.initialSnapshot);
  const [pending, setPending] = createSignal<PendingNavigation | null>(null);
  let committedSource = params.initialSource;
  let committedHref = params.initialSource;
  let nextNavigationId = 0;

  const view = query.create<string, { source: string; snapshot: CalendarSnapshot }, { cursor: string | null }>({
    source,
    initial: { source: params.initialSource, data: { source: params.initialSource, snapshot: params.initialSnapshot } },
    load: async (href, { abortSignal }) => {
      const snapshot = await loadSpacesViewSnapshot(href, abortSignal, locale());
      if (snapshot.kind !== "calendar") throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      return { source: href, snapshot };
    },
    subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
  });

  const current = () => {
    const loaded = view.data();
    return loaded?.source === source() ? loaded.snapshot : preview();
  };

  const restoreCommitted = (request: PendingNavigation, error: Error) => {
    if (pending()?.id !== request.id) return;
    setPending(null);
    setSource(committedSource);
    if (request.history === "popstate") {
      navigate(committedHref, { replace: true, scroll: "preserve", viewTransition: false });
      reconcileSpacesDetailRoute(committedHref);
    }
    if (error instanceof SpacesViewUnavailableError) window.location.reload();
    else prompts.error(error.message);
  };

  createEffect(() => {
    const request = pending();
    if (!request) return;
    if (view.loading() || view.refreshing()) request.started = true;

    const loaded = view.data();
    if (loaded?.source === request.source && !view.stale()) {
      committedSource = request.source;
      committedHref = request.href;
      setPreview(loaded.snapshot);
      setPending(null);
      if (request.history !== "popstate") {
        navigate(request.href, { replace: request.history === "replace", scroll: "preserve", viewTransition: false });
      }
      reconcileSpacesDetailRoute(request.href);
      return;
    }

    const error = view.error();
    if (request.started && error) restoreCommitted(request, error);
  });

  createEffect(() => {
    if (!pending() && view.error() instanceof SpacesViewUnavailableError) window.location.reload();
  });

  const start = (rawHref: string, history: PendingNavigation["history"]) => {
    const href = normalize(rawHref);
    if (!href) {
      documentNavigate(rawHref, { replace: history !== "push" });
      return;
    }
    const nextSource = calendarViewSource(href);
    if (nextSource === committedSource) {
      if (pending()) {
        setPending(null);
        setSource(committedSource);
      }
      committedHref = href;
      if (history === "replace") navigate(href, { replace: true, scroll: "preserve", viewTransition: false });
      reconcileSpacesDetailRoute(href);
      return;
    }
    const route = parseCalendarRoute(new URL(nextSource, window.location.origin), params.dateConfig);
    setPreview((snapshot) => ({ ...snapshot, ...route, items: [], weather: {} }));
    setPending({ id: ++nextNavigationId, href, source: nextSource, history, started: false });
    setSource(nextSource);
  };

  onMount(() => {
    const stopPopState = listenPopState(({ url }) => start(pathWithQuery(url), "popstate"));
    onCleanup(stopPopState);
  });

  return {
    current,
    error: view.error,
    refresh: view.refresh,
    pending: () => pending() !== null || view.loading() || view.refreshing(),
    navigateHref: (href: string) => start(href, "push"),
    open: (href: string, options: { replace?: boolean } = {}) => start(href, options.replace ? "replace" : "push"),
  };
};
