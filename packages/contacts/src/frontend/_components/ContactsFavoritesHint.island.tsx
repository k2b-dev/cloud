import { markHintSeen } from "@k2b/cloud/browser/hints";
import { MovedHint, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { CONTACTS_FAVORITES_HINT_ID } from "./contacts-hint-id";
import { resultsMessages } from "./results-messages";

/**
 * The one-time hint where the Favorites row used to be: rendered directly after the server-rendered
 * "All contacts" row, so the row stays a plain sidebar item (and a chip on phones) and keyboard order follows it.
 */
export default function ContactsFavoritesHint(props: { favoritesHref: string; open?: boolean }) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(Boolean(props.open));
  let marker: HTMLSpanElement | undefined;
  const seen = () => {
    markHintSeen(CONTACTS_FAVORITES_HINT_ID);
    setOpen(false);
  };
  const target = () => {
    const host = marker?.closest("solid-island, solid-client") ?? marker;
    const row = host?.previousElementSibling;
    return row instanceof HTMLElement ? (row.querySelector<HTMLElement>("a") ?? row) : undefined;
  };
  return (
    <>
      <span ref={marker} hidden />
      <MovedHint
        open={open()}
        target={target}
        placement="bottom"
        onDismiss={seen}
        action={{ label: t().showFavorites, href: props.favoritesHref }}
      >
        {t().favoritesMoved}
      </MovedHint>
    </>
  );
}
