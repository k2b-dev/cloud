import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { createScrollFade, scrollFadeEdges } from "../layout/scroll-fade";
import Dropdown, { type DropdownItem } from "./Dropdown";

export type ViewTab = { id: string; label: string; href: string; icon?: string; count?: number | string };
export type ViewTabsProps = {
  /** Accessible name of the navigation landmark, e.g. "Views". */
  label: string;
  items: readonly ViewTab[];
  /** Id of the open view; the server reads it from `?view=`. Unknown ids select nothing. */
  current: string | undefined;
  /** Tabs shown before More (default 5). */
  max?: number;
  class?: string;
};

/** Two deterministic strip levels; only opening the menu reads CSS visibility. */
export function viewTabsLayout(items: readonly ViewTab[], current: string | undefined, max = 5) {
  // At least one slot keeps the current view visible, including for an invalid limit.
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 5;
  const currentIndex = items.findIndex((item) => item.id === current);
  const visible = (size: number) => {
    const indices = items.slice(0, size).map((_, index) => index);
    if (currentIndex >= size) indices[indices.length - 1] = currentIndex;
    return indices;
  };
  const wide = visible(limit);
  const compact = visible(Math.min(limit, 3));
  return { wide, compact, wideHidden: items.length - wide.length, compactHidden: items.length - compact.length };
}

/** Self-contained: the server script embeds this before hydration. */
function settleViewTabs(list: Element | null, edges: (element: HTMLElement) => string | undefined, focused?: HTMLElement) {
  if (!(list instanceof HTMLElement)) return;
  const current = focused ?? list.querySelector(".k2b-view-tabs__tab[aria-current=page]");
  if (current && current.getClientRects().length > 0 && list.scrollWidth - list.clientWidth > 1) {
    const bounds = list.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    const fade = edges(list);
    const style = getComputedStyle(list);
    const left = fade === "top" || fade === "both" ? parseFloat(style.scrollPaddingLeft) || 0 : 0;
    const right = fade === "bottom" || fade === "both" ? parseFloat(style.scrollPaddingRight) || 0 : 0;
    if (item.left < bounds.left + left || item.right > bounds.right - right) {
      let offset = item.left - bounds.left - (bounds.width - item.width) / 2;
      if (focused) {
        // Reserve padding at the destination edge; native clamping drops it when that end is reached.
        offset =
          item.left < bounds.left + left
            ? item.left - bounds.left - (parseFloat(style.scrollPaddingLeft) || 0)
            : item.right - bounds.right + (parseFloat(style.scrollPaddingRight) || 0);
      }
      // Only the strip moves: scrollIntoView would also scroll the page. Instant keeps the first frame free of animation.
      list.scrollTo({ left: list.scrollLeft + offset, behavior: "instant" });
    }
  }
  const fade = edges(list);
  if (fade) list.setAttribute("data-scroll-fade", fade);
  else list.removeAttribute("data-scroll-fade");
}

type WatchedViewTabs = HTMLElement & {
  __k2bViewTabsWatch?: { resize: ResizeObserver; focus: (event: FocusEvent) => void; preferCurrent: boolean };
};

/** Also embedded, so it must not close over module state. */
function watchViewTabs(list: WatchedViewTabs | null, settle: typeof settleViewTabs, edges: (element: HTMLElement) => string | undefined) {
  if (!(list instanceof HTMLElement)) return;
  // A DOM property survives hydration: one observer and focus listener per reused list.
  let watch = list.__k2bViewTabsWatch;
  if (!watch) {
    const focus = (event: FocusEvent) => {
      // Pointer focus must not move the target under the pointer.
      if (watch && event.target instanceof HTMLElement && event.target.matches(".k2b-view-tabs__tab:focus-visible")) {
        watch.preferCurrent = false;
        settle(list, edges, event.target);
      }
    };
    watch = {
      resize: new ResizeObserver(() => {
        const focused = document.activeElement;
        if (
          watch?.preferCurrent === false &&
          focused instanceof HTMLElement &&
          list.contains(focused) &&
          focused.matches(".k2b-view-tabs__tab:focus-visible")
        )
          settle(list, edges, focused);
        else settle(list, edges);
      }),
      focus,
      preferCurrent: true,
    };
    Object.defineProperty(list, "__k2bViewTabsWatch", { value: watch, configurable: true });
    list.addEventListener("focusin", focus);
  }
  watch.preferCurrent = true;
  const { resize } = watch;
  resize.disconnect();
  // Head actions parse after the views; settle again after their layout, before paint, and on later resizes.
  resize.observe(list);
  for (const child of Array.from(list.children)) resize.observe(child);
  settle(list, edges);
  return watch;
}
const VIEW_TABS_SCRIPT = `(${watchViewTabs})(document.currentScript&&document.currentScript.previousElementSibling,${settleViewTabs},${scrollFadeEdges})`;

/**
 * URL-backed object views. Every view is an ordinary document link, in the strip and under More, so reload, back,
 * and forward keep the view the URL names.
 */
export function ViewTabs(props: ViewTabsProps): JSX.Element {
  const messages = useUiMessages();
  const layout = createMemo(() => viewTabsLayout(props.items, props.current, props.max));
  const stripItems = new Map<number, HTMLLIElement>();
  let list: HTMLUListElement | undefined;
  createScrollFade(
    () => list,
    () => true,
  );
  onMount(() => {
    const watch = watchViewTabs(list ?? null, settleViewTabs, scrollFadeEdges);
    onCleanup(() => {
      watch?.resize.disconnect();
      if (list && watch) {
        list.removeEventListener("focusin", watch.focus);
        Reflect.deleteProperty(list, "__k2bViewTabsWatch");
      }
    });
  });
  // User effects run after Solid's render effects, including For and aria-current, in the same task.
  createEffect(
    on(
      () => props.current,
      () => watchViewTabs(list ?? null, settleViewTabs, scrollFadeEdges),
      { defer: true },
    ),
  );
  const [open, setOpen] = createSignal(false);
  const [menuItems, setMenuItems] = createSignal<DropdownItem[]>([]);
  const onOpenChange = (next: boolean) => {
    if (next) {
      setMenuItems(
        props.items
          .filter(
            (item, index) =>
              item.id !== props.current && (!layout().wide.includes(index) || stripItems.get(index)?.getClientRects().length === 0),
          )
          .map((item) => ({
            href: item.href,
            label: item.label,
            icon: item.icon,
            trailing: item.count !== undefined ? <span class="k2b-view-tabs__count">{item.count}</span> : undefined,
          })),
      );
    }
    setOpen(next);
  };
  const tabContent = (item: ViewTab) => (
    <>
      <Show when={item.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      <span class="k2b-view-tabs__label k2b-truncate-fade">{item.label}</span>
      <Show when={item.count !== undefined}>
        <span class="k2b-view-tabs__count">{item.count}</span>
      </Show>
    </>
  );
  return (
    <nav class={`k2b-view-tabs ${props.class ?? ""}`} aria-label={props.label}>
      <ul ref={list} class="k2b-view-tabs__list" data-scroll-fade-mode="both" data-scroll-fade-axis="horizontal">
        <For each={layout().wide}>
          {(index) => {
            const item = () => props.items[index]!;
            onCleanup(() => stripItems.delete(index));
            return (
              <li
                ref={(element) => stripItems.set(index, element)}
                class="k2b-view-tabs__item"
                data-view-tab={item().id}
                data-compact-hidden={!layout().compact.includes(index) ? "" : undefined}
              >
                <a class="k2b-view-tabs__tab" href={item().href} aria-current={item().id === props.current ? "page" : undefined}>
                  {tabContent(item())}
                </a>
              </li>
            );
          }}
        </For>
        <Show when={layout().compactHidden + layout().wideHidden > 0}>
          <li class="k2b-view-tabs__more" data-wide={layout().wideHidden > 0 ? "" : undefined}>
            <Dropdown.Root items={menuItems()} open={open()} onOpenChange={onOpenChange} label={messages().moreViews}>
              <Dropdown.Trigger appearance="plain" class="k2b-view-tabs__tab k2b-view-tabs__more-trigger" label={messages().moreViews}>
                <span class="k2b-view-tabs__label">{messages().more}</span>
                <Show when={layout().wideHidden > 0}>
                  <span class="k2b-view-tabs__more-count" data-level="wide">
                    +{layout().wideHidden}
                  </span>
                </Show>
                <Show when={layout().compactHidden > 0}>
                  <span class="k2b-view-tabs__more-count" data-level="compact">
                    +{layout().compactHidden}
                  </span>
                </Show>
                <i class="ti ti-chevron-down" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </li>
        </Show>
      </ul>
      <script innerHTML={VIEW_TABS_SCRIPT} />
    </nav>
  );
}
