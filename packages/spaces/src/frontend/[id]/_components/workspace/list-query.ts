import { documentNavigate, listenPopState, navigate } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { batch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { ItemListResult } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { parseFilterFromUrl } from "../filter/types";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import { reconcileSpacesDetailRoute, SPACES_DETAIL_STATE_EVENT, subscribeToSpacesDataInvalidation } from "./workspace-events";

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

export const listViewSource = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  url.searchParams.delete("item");
  url.searchParams.delete("occurrence");
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
};

export const useSpacesListQuery = (props: { initialSource: string; initialItemsResult: ItemListResult; currentView: "list" | "table" }) => {
  const locale = useLocale();
  const t = useSpaceMessages();
  const initialSource = listViewSource(props.initialSource);
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
    initial: { source: initialSource, data: { source: initialSource, itemsResult: props.initialItemsResult } },
    load: async (href, { abortSignal }) => {
      const snapshot = await loadSpacesViewSnapshot(href, abortSignal, locale());
      if (snapshot.kind !== "list" || snapshot.currentView !== props.currentView) {
        throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      }
      return { source: href, itemsResult: snapshot.itemsResult };
    },
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["view"], async () => {
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
        request.history === "replace" || listViewSource(selection.href) === source() || selectionKey(selection) !== request.selection
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
    if (view.error() instanceof SpacesViewUnavailableError) window.location.reload();
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
    const next = listViewSource(href);
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
      if (listViewSource(href) === current().source) committedHref = href;
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
