import { documentNavigate, listenPopState, navigate } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { prompts, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { parseCalendarRoute } from "../calendar/filter";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import {
  reconcileSpacesDetailRoute,
  resolveCalendarNavigationHref,
  SPACES_DETAIL_STATE_EVENT,
  subscribeToSpacesDataInvalidation,
} from "./workspace-events";
import type { SpacesViewSnapshot } from "./workspace-types";

type CalendarSnapshot = Extract<SpacesViewSnapshot, { kind: "calendar" }>;
type PendingNavigation = {
  id: number;
  href: string;
  source: string;
  history: "push" | "replace" | "popstate";
  started: boolean;
  selection: string;
};

const pathWithQuery = (url: URL) => `${url.pathname}${url.search}`;
const selectionKey = (url: URL) => JSON.stringify([url.searchParams.get("item"), url.searchParams.get("occurrence")]);
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
  const initialSource = calendarViewSource(params.initialSource);
  const [source, setSource] = createSignal(initialSource);
  const [preview, setPreview] = createSignal<CalendarSnapshot>(params.initialSnapshot);
  const [pending, setPending] = createSignal<PendingNavigation | null>(null);
  let committedSource = initialSource;
  let committedHref = params.initialSource;
  let nextNavigationId = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const view = query.create<string, { source: string; snapshot: CalendarSnapshot }, { cursor: string | null }>({
    source,
    initial: { source: initialSource, data: { source: initialSource, snapshot: params.initialSnapshot } },
    load: async (href, { abortSignal }) => {
      const snapshot = await loadSpacesViewSnapshot(href, abortSignal, locale());
      if (snapshot.kind !== "calendar") throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      return { source: href, snapshot };
    },
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["view"], async (event) => {
        // Navigation supersedes old-source coverage, but the live cursor still
        // requires a fresh snapshot of the newly active calendar.
        while (!disposed) {
          const requestedSource = source();
          try {
            await invalidate(event);
            return;
          } catch (error) {
            if (disposed || requestedSource === source()) throw error;
          }
        }
      }),
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
      const selection = new URL(window.location.href);
      if (selectionKey(selection) !== request.selection) {
        const target = new URL(committedHref, window.location.origin);
        for (const key of ["item", "occurrence"]) {
          const value = selection.searchParams.get(key);
          if (value === null) target.searchParams.delete(key);
          else target.searchParams.set(key, value);
        }
        committedHref = pathWithQuery(target);
      }
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
      const target = new URL(request.href, window.location.origin);
      const selection = new URL(window.location.href);
      if (selectionKey(selection) !== request.selection) {
        for (const key of ["item", "occurrence"]) {
          const value = selection.searchParams.get(key);
          if (value === null) target.searchParams.delete(key);
          else target.searchParams.set(key, value);
        }
      }
      committedSource = request.source;
      committedHref = pathWithQuery(target);
      setPreview(loaded.snapshot);
      setPending(null);
      if (request.history !== "popstate") {
        navigate(committedHref, { replace: request.history === "replace", scroll: "preserve", viewTransition: false });
      }
      reconcileSpacesDetailRoute(committedHref);
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
    setPending({
      id: ++nextNavigationId,
      href,
      source: nextSource,
      history,
      started: false,
      selection: selectionKey(new URL(window.location.href)),
    });
    setSource(nextSource);
  };

  onMount(() => {
    committedHref = pathWithQuery(new URL(window.location.href));
    const rememberDetailSelection = () => {
      const href = pathWithQuery(new URL(window.location.href));
      if (calendarViewSource(href) === committedSource) committedHref = href;
    };
    window.addEventListener(SPACES_DETAIL_STATE_EVENT, rememberDetailSelection);
    onCleanup(() => window.removeEventListener(SPACES_DETAIL_STATE_EVENT, rememberDetailSelection));
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
