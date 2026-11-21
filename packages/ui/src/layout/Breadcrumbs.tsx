import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { useUiMessages } from "../intl/messages";
import { createScrollFade } from "./scroll-fade";

export type BreadcrumbItem = {
  label: string;
  /** A link to this level, for a path in a page head. Without it the level calls `onSelect`. */
  href?: string;
};

export type BreadcrumbsProps = {
  /** The path from the top: every item but the last leads to its level, the last is the current place. */
  items: readonly BreadcrumbItem[];
  /** Names the path for assistive technology, for example "Path". */
  label: string;
  /** Called with the index of the level that was activated; never for the current place. */
  onSelect?: (index: number) => void;
  disabled?: boolean;
  class?: string;
};

/**
 * A path, in a page head (`AppWorkspace.Head` `views`) or inside a dialog or panel: the levels above in quiet text,
 * the current level in strong text. It stays on one line (K15): when the path does not fit, the front levels give
 * way first and wait behind "…", which opens them as a menu; the current level always stays. Before the browser
 * measures, a long path scrolls sideways with a fade on the side where more follows and shows its end.
 */
export function Breadcrumbs(props: BreadcrumbsProps): JSX.Element {
  const messages = useUiMessages();
  let nav: HTMLElement | undefined;
  let list: HTMLOListElement | undefined;
  // How many front levels wait behind "…"; the current level never does.
  const [hidden, setHidden] = createSignal(0);
  createScrollFade(
    () => list,
    () => true,
  );
  // The collapse measures in the browser only, so its code loads there, after the first paint.
  let refresh: (() => void) | undefined;
  onMount(() => {
    if (!nav || !list || typeof ResizeObserver === "undefined") return;
    let disposed = false;
    let dispose: (() => void) | undefined;
    onCleanup(() => {
      disposed = true;
      dispose?.();
    });
    void import("./breadcrumbs-collapse").then(({ observeBreadcrumbs }) => {
      if (disposed || !nav || !list) return;
      const collapse = observeBreadcrumbs(nav, list, () => props.items.length, setHidden);
      refresh = collapse.refresh;
      dispose = collapse.dispose;
    });
  });
  // The current level is the end of the path: keep it in view after every change. Horizontal RTL counts negative.
  createEffect(
    on(
      () => props.items.map((item) => item.label).join("\u0000"),
      () => {
        if (!list) return;
        const rtl = getComputedStyle(list).direction === "rtl";
        list.scrollLeft = rtl ? -list.scrollWidth : list.scrollWidth;
        refresh?.();
      },
    ),
  );
  const select = (index: number) => {
    if (!props.disabled) props.onSelect?.(index);
  };
  const hiddenItems = (): DropdownItem[] =>
    props.items
      .slice(0, hidden())
      .map((item, index) => (item.href ? { label: item.label, href: item.href } : { label: item.label, action: () => select(index) }));
  return (
    <nav ref={nav} class={`k2b-breadcrumbs ${props.class ?? ""}`} aria-label={props.label}>
      <ol ref={list} class="k2b-breadcrumbs__list" data-scroll-fade-mode="both" data-scroll-fade-axis="horizontal">
        <Show when={hidden() > 0}>
          <li class="k2b-breadcrumbs__item k2b-breadcrumbs__more">
            <Dropdown items={hiddenItems()}>
              <Dropdown.Trigger
                class="k2b-breadcrumbs__link"
                variant="ghost"
                size="sm"
                label={messages().pathLevelsAbove}
                disabled={props.disabled}
              >
                …
              </Dropdown.Trigger>
            </Dropdown>
          </li>
        </Show>
        <For each={props.items}>
          {(item, index) => {
            const current = () => index() === props.items.length - 1;
            return (
              <li class="k2b-breadcrumbs__item" hidden={index() < hidden()}>
                <Show when={index() > 0}>
                  <i class="ti ti-chevron-right k2b-breadcrumbs__separator" aria-hidden="true" />
                </Show>
                <Show
                  when={!current()}
                  fallback={
                    <span class="k2b-breadcrumbs__current" aria-current="location">
                      {item.label}
                    </span>
                  }
                >
                  <Show
                    when={item.href}
                    fallback={
                      <Button variant="link" class="k2b-breadcrumbs__link" disabled={props.disabled} onClick={() => select(index())}>
                        {item.label}
                      </Button>
                    }
                  >
                    {(href) => (
                      // A disabled level is no link: without `href` it neither navigates nor takes focus.
                      <a
                        class="k2b-breadcrumbs__link"
                        href={props.disabled ? undefined : href()}
                        aria-disabled={props.disabled ? "true" : undefined}
                      >
                        {item.label}
                      </a>
                    )}
                  </Show>
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </nav>
  );
}
