import { ButtonLink, useLocale } from "@k2b/ui";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { bookMessages } from "./messages";
import { createSignal, onCleanup, onMount } from "solid-js";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";

export default function PresentationModeLinks(props: { href: string; mode: PresentationMode; locked: boolean }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [href, setHref] = createSignal(props.href);
  onMount(() => {
    const onNote = (event: Event) => {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (!noteId || !/^[A-Za-z0-9]{6}$/.test(noteId)) return;
      const url = new URL(window.location.href);
      url.pathname = url.pathname.replace(/\/notes\/[^/]+$/, `/notes/${noteId}`);
      setHref(`${url.pathname}${url.search}`);
    };
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onNote);
    onCleanup(() => window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onNote));
  });
  return (
    <nav aria-label={t().modes} class="notebook-presentation-modes">
      {(["book", "write", "readonly"] as const)
        .filter((mode) => mode !== "write" || !props.locked)
        .map((mode) => (
          <ButtonLink
            href={withPresentationMode(href(), mode)}
            variant={mode === props.mode ? "subtle" : "ghost"}
            size="xs"
            aria-current={mode === props.mode ? "page" : undefined}
          >
            {t()[mode]}
          </ButtonLink>
        ))}
    </nav>
  );
}
