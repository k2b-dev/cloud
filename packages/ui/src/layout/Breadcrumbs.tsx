import { createEffect, For, type JSX, on, Show } from "solid-js";
import { Button } from "../actions/Button";
import { createScrollFade } from "./scroll-fade";

export type BreadcrumbItem = { label: string };

export type BreadcrumbsProps = {
  /** The path from the top: every item but the last is a link, the last is the current place. */
  items: readonly BreadcrumbItem[];
  /** Names the path for assistive technology, for example "Path". */
  label: string;
  /** Called with the index of the link that was activated; never for the current place. */
  onSelect: (index: number) => void;
  disabled?: boolean;
  class?: string;
};

/**
 * A path inside a dialog or panel: the levels above as blue text links, the current level as text. It stays on one
 * line; a long path scrolls sideways with a fade on the side where more follows, and shows its end after each change.
 */
export function Breadcrumbs(props: BreadcrumbsProps): JSX.Element {
  let list: HTMLOListElement | undefined;
  createScrollFade(
    () => list,
    () => true,
  );
  // The current level is the end of the path: keep it in view after every change. Horizontal RTL counts negative.
  createEffect(
    on(
      () => props.items.length,
      () => {
        if (!list) return;
        const rtl = getComputedStyle(list).direction === "rtl";
        list.scrollLeft = rtl ? -list.scrollWidth : list.scrollWidth;
      },
    ),
  );
  return (
    <nav class={`k2b-breadcrumbs ${props.class ?? ""}`} aria-label={props.label}>
      <ol ref={list} class="k2b-breadcrumbs__list" data-scroll-fade-mode="both" data-scroll-fade-axis="horizontal">
        <For each={props.items}>
          {(item, index) => {
            const current = () => index() === props.items.length - 1;
            return (
              <li class="k2b-breadcrumbs__item">
                <Show when={index() > 0}>
                  <span class="k2b-breadcrumbs__separator" aria-hidden="true">
                    /
                  </span>
                </Show>
                <Show
                  when={!current()}
                  fallback={
                    <span class="k2b-breadcrumbs__current" aria-current="location">
                      {item.label}
                    </span>
                  }
                >
                  <Button variant="link" class="k2b-breadcrumbs__link" disabled={props.disabled} onClick={() => props.onSelect(index())}>
                    {item.label}
                  </Button>
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </nav>
  );
}
