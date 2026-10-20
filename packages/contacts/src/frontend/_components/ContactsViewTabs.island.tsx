import { markHintSeen } from "@k2b/cloud/browser/hints";
import { ViewTabs, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { contactsViewHref, readContactsQueryOptions } from "../contacts-query";
import { CONTACTS_FAVORITES_HINT_ID } from "./contacts-hint-id";
import { connectContactsHead, plainContactsClick } from "./contacts-head-events";
import { listenForContactFavoriteChanges } from "./contacts-favorites";
import { resultsMessages } from "./results-messages";

export default function ContactsViewTabs(props: { initialHref: string; bookId?: string; allCount: number; favoritesCount: number }) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [href, setHref] = createSignal(props.initialHref);
  const [allCount, setAllCount] = createSignal(props.allCount);
  const [favoritesCount, setFavoritesCount] = createSignal(props.favoritesCount);
  const favorites = () => readContactsQueryOptions(href()).favorites;
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const bridge = connectContactsHead((state) => {
      setHref(state.source);
      if (!state.filtered && !state.busy) {
        if (readContactsQueryOptions(state.source).favorites) setFavoritesCount(state.total);
        else setAllCount(state.total);
      }
    });
    onCleanup(bridge.dispose);
    onCleanup(
      listenForContactFavoriteChanges((change) => {
        if (!favorites() && (!props.bookId || change.bookId === props.bookId))
          setFavoritesCount((count) => Math.max(0, count + (change.favorite ? 1 : -1)));
      }),
    );
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
          { id: "all", label: t().allView, href: contactsViewHref(href(), false), count: allCount() },
          { id: "favorites", label: t().favoritesView, href: contactsViewHref(href(), true), count: favoritesCount() },
        ]}
      />
    </div>
  );
}
