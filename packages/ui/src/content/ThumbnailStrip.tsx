import { createEffect, For, type JSX, on, Show } from "solid-js";
import { IconButton } from "../actions/Button";
import { createScrollFade } from "../layout/scroll-fade";
import { useThumbnailStripMessages } from "./thumbnail-strip-messages";

/** One image in a `ThumbnailStrip`. */
export type ThumbnailStripItem = {
  id: string;
  name: string;
  /** Small image URL, or a component that renders the caller's own thumbnail; a neutral tile shows until it loads. */
  thumbnail?: string | (() => JSX.Element);
  /** Marks an image with unsaved edits. */
  dirty?: boolean;
};

export type ThumbnailStripProps = {
  items: readonly ThumbnailStripItem[];
  /** The `id` of the shown image; it is ringed, scrolled into view, and the strip's one tab stop. */
  currentItem?: string;
  onSelectItem: (id: string) => void;
  /** Adds a "+" tile at the end. */
  onAddItems?: () => void;
  /** Accessible name of the strip, such as "Images". */
  label: string;
  /** The host's layer class, such as `k2b-overlay-surface` where the strip floats over a picture. */
  class?: string;
};

/** Room an item keeps from a fading edge when keyboard focus scrolls it into view. */
const EDGE = 48;

/**
 * A row of image thumbnails, 44 px high, that scrolls sideways and fades softly only on the side where more images
 * follow. The current image is ringed and is the strip's one tab stop; the arrow keys, Home, and End move focus between
 * images, and Enter or a click shows one. A dot marks unsaved edits. The host decides where the strip sits, also on a
 * phone, and whether it floats over a picture.
 */
export function ThumbnailStrip(props: ThumbnailStripProps): JSX.Element {
  const messages = useThumbnailStripMessages();
  let list: HTMLUListElement | undefined;
  createScrollFade(
    () => list,
    () => true,
  );

  // The current image scrolls into the middle whenever it or the list changes.
  createEffect(
    on(
      () => [props.currentItem, props.items.length] as const,
      () =>
        queueMicrotask(() => {
          const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
          if (!list || !current) return;
          list.style.scrollBehavior = "auto";
          list.scrollLeft = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
          list.style.scrollBehavior = "";
        }),
    ),
  );

  // A native listener, so a host that handles arrow keys itself, such as a lightbox, does not also see them.
  const keys = (event: KeyboardEvent) => {
    // The "+" tile takes part in the arrow keys, so the keyboard reaches it without a tab stop of its own.
    const thumbs = [...(list?.querySelectorAll<HTMLButtonElement>(".k2b-thumbnail-strip__thumb, .k2b-thumbnail-strip__add") ?? [])];
    const at = thumbs.findIndex((thumb) => thumb === document.activeElement);
    if (at < 0 || !list) return;
    const to = { ArrowRight: Math.min(thumbs.length - 1, at + 1), ArrowLeft: Math.max(0, at - 1), Home: 0, End: thumbs.length - 1 }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    thumbs.forEach((thumb, index) => {
      thumb.tabIndex = index === to ? 0 : -1;
    });
    const target = thumbs[to];
    if (!target) return;
    target.focus({ preventScroll: true });
    if (target.offsetLeft < list.scrollLeft + EDGE) list.scrollLeft = target.offsetLeft - EDGE;
    else if (target.offsetLeft + target.offsetWidth > list.scrollLeft + list.clientWidth - EDGE)
      list.scrollLeft = target.offsetLeft + target.offsetWidth - list.clientWidth + EDGE;
  };

  return (
    <nav class={`k2b-thumbnail-strip ${props.class ?? ""}`} aria-label={props.label}>
      <ul ref={list} data-scroll-fade-mode="both" data-scroll-fade-axis="horizontal" on:keydown={keys}>
        <For each={props.items}>
          {(item) => {
            const current = () => item.id === props.currentItem;
            return (
              <li>
                <button
                  type="button"
                  class="k2b-thumbnail-strip__thumb"
                  aria-current={current()}
                  tabindex={current() ? 0 : -1}
                  aria-label={`${item.name}${current() ? `, ${messages().thumbnailCurrent}` : ""}${item.dirty ? `, ${messages().thumbnailUnsaved}` : ""}`}
                  title={item.name}
                  onClick={() => {
                    if (!current()) props.onSelectItem(item.id);
                  }}
                >
                  {(() => {
                    const thumbnail = item.thumbnail;
                    if (typeof thumbnail === "function") return thumbnail();
                    return thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false} /> : null;
                  })()}
                  <Show when={item.dirty}>
                    <span class="k2b-thumbnail-strip__dirty" aria-hidden="true" />
                  </Show>
                </button>
              </li>
            );
          }}
        </For>
        <Show when={props.onAddItems}>
          {(add) => (
            <li>
              <IconButton class="k2b-thumbnail-strip__add" size="sm" tabindex="-1" label={messages().thumbnailAdd} onClick={() => add()()}>
                <i class="ti ti-plus" aria-hidden="true" />
              </IconButton>
            </li>
          )}
        </Show>
      </ul>
    </nav>
  );
}
