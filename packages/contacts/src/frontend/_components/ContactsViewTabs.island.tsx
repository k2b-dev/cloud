import { markHintSeen } from "@k2b/cloud/browser/hints";
import { query } from "@k2b/stdlib/solid";
import { IconButton, useLocale, ViewTabs } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { contactsViewHref, readContactsQueryOptions } from "../contacts-query";
import { listenForContactFavoriteChanges } from "./contacts-favorites";
import { connectContactsHead, plainContactsClick } from "./contacts-head-events";
import { CONTACTS_FAVORITES_HINT_ID } from "./contacts-hint-id";
import { listenForContactsLiveInvalidation, requiresContactsResultsRefresh } from "./contacts-live";
import { resultsMessages } from "./results-messages";

export default function ContactsViewTabs(props: { initialHref: string; bookId?: string; allCount: number; favoritesCount: number }) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [href, setHref] = createSignal(props.initialHref);
  const favorites = () => readContactsQueryOptions(href()).favorites;
  const counts = query.create({
    source: () => props.bookId,
    initial: { source: props.bookId, data: { all: props.allCount, favorites: props.favoritesCount } },
    load: async (bookId, { abortSignal }) => {
      const fetchCount = async (favorites: boolean) => {
        const query = { page: "1", per_page: "1", ...(favorites ? { favorites: "true" as const } : {}) };
        const options = { init: { signal: abortSignal } };
        const response = bookId
          ? await apiClient.books[":bookId"].contacts.$get({ param: { bookId }, query }, options)
          : await apiClient.search.$get({ query }, options);
        if (!response.ok) throw new Error(t().couldNotUpdateContactCounts);
        return (await response.json()).pagination.total;
      };
      // Settle both reads before permitting a queued refresh, including after failure.
      const [all, favorites] = await Promise.allSettled([fetchCount(false), fetchCount(true)]);
      if (all.status === "rejected") throw all.reason;
      if (favorites.status === "rejected") throw favorites.reason;
      return { all: all.value, favorites: favorites.value };
    },
    subscribe: ({ invalidate }) => {
      const stopFavorites = listenForContactFavoriteChanges((change) => {
        if (!props.bookId || change.bookId === props.bookId) void invalidate().catch(() => {});
      });
      const stopLive = listenForContactsLiveInvalidation("results", (event) => {
        if (requiresContactsResultsRefresh(event)) return invalidate();
      });
      return () => {
        stopFavorites();
        stopLive();
      };
    },
  });
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const bridge = connectContactsHead((state) => setHref(state.source));
    onCleanup(bridge.dispose);
    const seen = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (plainContactsClick(event) && anchor && root?.contains(anchor) && anchor.getAttribute("href") === contactsViewHref(href(), true))
        markHintSeen(CONTACTS_FAVORITES_HINT_ID);
    };
    document.addEventListener("click", seen, true);
    onCleanup(() => document.removeEventListener("click", seen, true));
  });
  return (
    <div ref={root} class="contacts-view-tabs">
      <ViewTabs
        label={t().contactViews}
        current={favorites() ? "favorites" : "all"}
        items={[
          { id: "all", label: t().allView, href: contactsViewHref(href(), false), count: counts.data()?.all },
          { id: "favorites", label: t().favoritesView, href: contactsViewHref(href(), true), count: counts.data()?.favorites },
        ]}
      />
      <IconButton
        class="contacts-count-retry"
        size="xs"
        label={t().retryContactCounts}
        style={{ visibility: counts.error() ? "visible" : "hidden" }}
        disabled={!counts.error() || counts.refreshing()}
        onClick={() => void counts.refresh()}
      >
        <i class="ti ti-alert-circle" aria-hidden="true" />
      </IconButton>
      <Show when={counts.error()}>
        <span class="k2b-sr-only" role="alert">
          {t().couldNotUpdateContactCounts}
        </span>
      </Show>
    </div>
  );
}
