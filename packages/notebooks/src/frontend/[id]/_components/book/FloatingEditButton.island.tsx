import { IconButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export default function FloatingEditButton(props: { href: string; mode: PresentationMode; locked: boolean; canWrite: boolean }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [href, setHref] = createSignal(props.href);
  const [locked, setLocked] = createSignal(props.locked);
  const [canWrite, setCanWrite] = createSignal(props.canWrite);
  const [hasNote, setHasNote] = createSignal(/\/notes\/[A-Za-z0-9]{6}(?:[?#]|$)/.test(props.href));
  onMount(() => {
    const onNote = (event: Event) => {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (!noteId || !/^[A-Za-z0-9]{6}$/.test(noteId)) return;
      const url = new URL(window.location.href);
      url.pathname = url.pathname.replace(/\/notes\/[^/]+$/, `/notes/${noteId}`);
      setHref(`${url.pathname}${url.search}`);
    };
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onNote);
    const onBook = (event: Event) => {
      if (props.mode !== "book") return;
      const next = (event as CustomEvent<BookMetadata>).detail;
      setHref(next.href);
      setLocked(next.locked);
      setCanWrite(next.canWrite);
      setHasNote(!!next.selectedNoteId);
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    onCleanup(() => {
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onNote);
      window.removeEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    });
  });
  return (
    <Show when={canWrite() && !locked() && hasNote()}>
      <div class="notebook-floating-edit">
        <Tooltip.Anchor content={t().editNote}>
          <IconButtonLink
            href={withPresentationMode(href(), "write")}
            label={t().editNote}
            tooltip={false}
            variant="primary"
            size="lg"
            class="notebook-floating-edit-button"
          >
            <i class="ti ti-pencil" aria-hidden="true" />
          </IconButtonLink>
        </Tooltip.Anchor>
      </div>
    </Show>
  );
}
