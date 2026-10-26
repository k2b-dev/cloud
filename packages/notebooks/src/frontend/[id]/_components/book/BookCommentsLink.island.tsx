import { ButtonLink, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { commentMessages } from "../comments/messages";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";

/** The note's open comments in Book: a quiet entry that opens Read at the first one; Book itself shows none. */
export const commentsHref = (href: string) => {
  const url = new URL(withPresentationMode(href, "readonly"), "http://local");
  url.searchParams.set("annotation", "first");
  url.hash = "";
  return `${url.pathname}${url.search}`;
};

export default function BookCommentsLink(props: { href: string; count: number }) {
  const locale = useLocale();
  const t = () => commentMessages.resolve([locale()]).t;
  const [state, setState] = createSignal({ href: props.href, count: props.count });
  onMount(() => {
    const onBook = (event: Event) => {
      const next = (event as CustomEvent<BookMetadata>).detail;
      setState({ href: next.href, count: next.selectedNoteId ? (next.openComments ?? 0) : 0 });
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, onBook));
  });
  return (
    <Show when={state().count > 0}>
      <ButtonLink href={commentsHref(state().href)} size="sm" variant="ghost" class="text-dimmed shrink-0">
        <i class="ti ti-message-circle" aria-hidden="true" />
        {t().bookEntry({ count: state().count })}
      </ButtonLink>
    </Show>
  );
}
