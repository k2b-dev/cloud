import { reloadOnce } from "@k2b/cloud/browser/reload";
import { documentNavigate, listenPopState, navigate } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { prompts, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { CALENDAR_COLOR_PARAM, parseCalendarColorBy, parseCalendarRoute } from "../calendar/filter";
import type { TimelineRange } from "../calendar/timeline";
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
/**
 * The calendar data an href needs, in one form for equal data: the selected item and the color choice change no
 * calendar data, this query only loads the calendar view, and the order of the parameters means nothing. The page's
 * base URL names the view only when it overrides the saved one, while the calendar's own links always name it.
 */
export const calendarViewSource = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  url.searchParams.delete("item");
  url.searchParams.delete("occurrence");
  url.searchParams.delete(CALENDAR_COLOR_PARAM);
  url.searchParams.set("view", "calendar");
  url.searchParams.sort();
  return pathWithQuery(url);
};
const colorByOf = (href: string) => parseCalendarColorBy(new URL(href, "http://spaces.local"));

export const useSpacesCalendarQuery = (params: {
  spaceId: string;
  initialSource: string;
  initialSnapshot: CalendarSnapshot;
  dateConfig?: Parameters<typeof parseCalendarRoute>[1];
  /**
   * The range the timeline already shows for a source, so a refresh or a new filter covers all of it. Called once as
   * each snapshot starts to load.
   */
  timelineRange?: (source: string) => TimelineRange | undefined;
}) => {
  const locale = useLocale();
  const t = useSpaceMessages();
  const expectedPath = `/app/spaces/${params.spaceId}`;
  const normalize = (href: string) => resolveCalendarNavigationHref(href, window.location.origin, expectedPath);
  const initialSource = calendarViewSource(params.initialSource);
  const [source, setSource] = createSignal(initialSource);
  const [preview, setPreview] = createSignal<CalendarSnapshot>(params.initialSnapshot);
  const [pending, setPending] = createSignal<PendingNavigation | null>(null);
  // The committed color choice: it changes with the URL alone and never waits for, or reloads, calendar data.
  const [colorBy, setColorBy] = createSignal(params.initialSnapshot.filter.colorBy);
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
      const snapshot = await loadSpacesViewSnapshot(
        href,
        abortSignal,
        locale(),
        untrack(() => params.timelineRange?.(href)),
      );
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

  const current = createMemo((): CalendarSnapshot => {
    const loaded = view.data();
    const snapshot = loaded?.source === source() ? loaded.snapshot : preview();
    return { ...snapshot, filter: { ...snapshot.filter, colorBy: colorBy() } };
  });

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
      setColorBy(colorByOf(committedHref));
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
    if (!pending() && view.error() instanceof SpacesViewUnavailableError) reloadOnce(`spaces:view:${window.location.pathname}`);
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
      setColorBy(colorByOf(href));
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
      // A replacing change, such as a filter, during a pending push still adds that push's entry, so Back returns.
      history: history === "replace" && pending()?.history === "push" ? "push" : history,
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
    /** The last snapshot loaded, with its source; it stays while a navigation loads the next one. */
    loaded: view.data,
    error: view.error,
    refresh: view.refresh,
    pending: () => pending() !== null || view.loading() || view.refreshing(),
    navigateHref: (href: string) => start(href, "push"),
    open: (href: string, options: { replace?: boolean } = {}) => start(href, options.replace ? "replace" : "push"),
  };
};
