import { reloadOnce } from "@k2b/cloud/browser/reload";
import { documentNavigate, listenPopState, navigate } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { batch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { parseFilterFromUrl } from "../filter/types";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import {
  reconcileSpacesDetailRoute,
  SPACES_DETAIL_STATE_EVENT,
  type SpacesDataDomain,
  subscribeToSpacesDataInvalidation,
} from "./workspace-events";
import type { SpacesViewSnapshot } from "./workspace-types";

const selectionKey = (url: URL) => JSON.stringify([url.searchParams.get("item"), url.searchParams.get("occurrence")]);
const withSelection = (href: string, selection: URL) => {
  const target = new URL(href, selection.origin);
  for (const key of ["item", "occurrence"]) {
    const value = selection.searchParams.get(key);
    if (value === null) target.searchParams.delete(key);
    else target.searchParams.set(key, value);
  }
  return `${target.pathname}${target.search}`;
};

export const routeViewSource = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  url.searchParams.delete("item");
  url.searchParams.delete("occurrence");
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
};

/**
 * Keeps a URL-filtered workspace view (list, table, or Kanban) in step with its URL: a filter change
 * loads the snapshot for the new URL first and commits it to history only once that snapshot is shown.
 */
export const useSpacesRouteQuery = <T extends object>(props: {
  initialSource: string;
  initialData: T;
  currentView: "list" | "table" | "kanban";
  /** Picks this view's data from a snapshot, or null when the URL now selects another view. */
  read: (snapshot: SpacesViewSnapshot) => T | null;
  /** Live domains that reload the whole snapshot; finer-grained queries inside the view may cover the rest. */
  domains: SpacesDataDomain[];
}) => {
  const locale = useLocale();
  const t = useSpaceMessages();
  const initialSource = routeViewSource(props.initialSource);
  const [source, setSource] = createSignal(initialSource);
  const [pending, setPending] = createSignal<{ href: string; history: "replace" | "popstate"; selection: string } | null>(null);
  const [searchReset, setSearchReset] = createSignal(0);
  let committedHref = props.initialSource;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const view = query.create({
    source,
    initial: { source: initialSource, data: { ...props.initialData, source: initialSource } },
    load: async (href, { abortSignal }) => {
      const data = props.read(await loadSpacesViewSnapshot(href, abortSignal, locale()));
      if (!data) throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      return { ...data, source: href };
    },
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(props.domains, async () => {
        // A new search supersedes coverage for the old URL. Cover the new source
        // before acknowledging the live cursor instead of treating navigation as a load failure.
        while (!disposed) {
          const requestedSource = source();
          try {
            await invalidate();
            return;
          } catch (error) {
            if (disposed || requestedSource === source()) throw error;
          }
        }
      }),
  });
  const current = () => view.data()!;

  createEffect(() => {
    const request = pending();
    if (!request) return;
    if (current().source === source() && !view.stale()) {
      // Item selection can change independently while the list request is in flight.
      // A failed popstate restores another source; retry must retain its target selection.
      const selection = new URL(window.location.href);
      committedHref =
        request.history === "replace" || routeViewSource(selection.href) === source() || selectionKey(selection) !== request.selection
          ? withSelection(request.href, selection)
          : request.href;
      setPending(null);
      navigate(committedHref, { replace: true, scroll: "preserve", viewTransition: false });
      reconcileSpacesDetailRoute(committedHref);
    } else if (view.error() && request.history === "popstate") {
      const selection = new URL(window.location.href);
      if (selectionKey(selection) !== request.selection) {
        committedHref = withSelection(committedHref, selection);
        request.href = withSelection(request.href, selection);
      }
      // The rollback is not a user selection; do not adopt it on another retry.
      request.selection = selectionKey(new URL(committedHref, window.location.origin));
      navigate(committedHref, { replace: true, scroll: "preserve", viewTransition: false });
      reconcileSpacesDetailRoute(committedHref);
    }
  });
  createEffect(() => {
    if (view.error() instanceof SpacesViewUnavailableError) reloadOnce(`spaces:view:${window.location.pathname}`);
  });

  const open = (href: string, history: "replace" | "popstate" = "replace") => {
    const target = new URL(href, window.location.origin);
    const initial = new URL(props.initialSource, window.location.origin);
    if (
      target.origin !== initial.origin ||
      target.pathname !== initial.pathname ||
      (target.searchParams.get("view") ?? props.currentView) !== props.currentView
    ) {
      documentNavigate(href, { replace: true });
      return;
    }
    const next = routeViewSource(href);
    if (next === source()) {
      if (history === "popstate") {
        if (!pending()) committedHref = href;
        setSearchReset((value) => value + 1);
        if (pending()) setPending({ href, history, selection: selectionKey(new URL(window.location.href)) });
      }
      if (view.error()) void view.refresh();
      return;
    }
    batch(() => {
      setSource(next);
      setPending({ href, history, selection: selectionKey(new URL(window.location.href)) });
      if (history === "popstate") setSearchReset((value) => value + 1);
    });
  };
  onMount(() => {
    committedHref = `${window.location.pathname}${window.location.search}`;
    const rememberDetailSelection = () => {
      const href = `${window.location.pathname}${window.location.search}`;
      if (routeViewSource(href) === current().source) committedHref = href;
    };
    window.addEventListener(SPACES_DETAIL_STATE_EVENT, rememberDetailSelection);
    onCleanup(() => window.removeEventListener(SPACES_DETAIL_STATE_EVENT, rememberDetailSelection));
    onCleanup(listenPopState(({ url }) => open(`${url.pathname}${url.search}`, "popstate")));
  });

  return {
    current,
    filter: () => parseFilterFromUrl(new URL(current().source, "http://spaces.local")),
    requestedFilter: () => parseFilterFromUrl(new URL(source(), "http://spaces.local")),
    source,
    open,
    error: view.error,
    refresh: view.refresh,
    busy: () => view.loading() || view.refreshing(),
    searchReset,
    resetSearch: () => setSearchReset((value) => value + 1),
  };
};
