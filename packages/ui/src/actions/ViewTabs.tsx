import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { createScrollFade, scrollFadeEdges } from "../layout/scroll-fade";
import Dropdown, { type DropdownItem } from "./Dropdown";

export type ViewTab = {
  id: string;
  label: string;
  href: string;
  icon?: string;
  count?: number | string;
  /** A short quiet label after the count, such as "New" for a view people have not opened yet. */
  badge?: string;
  /** Stays in the strip after More at every width, for a view of another kind than the ones that overflow. */
  pinned?: boolean;
};
export type ViewTabsProps = {
  /** Accessible name of the navigation landmark, e.g. "Views". */
  label: string;
  items: readonly ViewTab[];
  /** Id of the open view; the server reads it from `?view=`. Unknown ids select nothing. */
  current: string | undefined;
  /** At most this many views before More (default 5). */
  max?: number;
  /**
   * The strip shows only the views that fit its room and counts the rest in More, instead of scrolling them. The open
   * view and pinned views stay. Pair it with a larger `max` so a wide head shows more views.
   */
  fit?: boolean;
  class?: string;
};

/** Two deterministic strip levels; only opening the menu reads CSS visibility. */
export function viewTabsLayout(items: readonly ViewTab[], current: string | undefined, max = 5) {
  // At least one slot keeps the current view visible, including for an invalid limit.
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 5;
  // Pinned views never overflow, so they take no slot.
  const flowing = items.flatMap((item, index) => (item.pinned ? [] : [index]));
  const pinned = items.flatMap((item, index) => (item.pinned ? [index] : []));
  const currentIndex = items.findIndex((item) => item.id === current);
  const currentPosition = flowing.indexOf(currentIndex);
  const visible = (size: number) => {
    const indices = flowing.slice(0, size);
    if (currentPosition >= size) indices[indices.length - 1] = currentIndex;
    return indices;
  };
  const wide = visible(limit);
  const compact = visible(Math.min(limit, 3));
  return { wide, compact, pinned, wideHidden: flowing.length - wide.length, compactHidden: flowing.length - compact.length };
}

/**
 * Self-contained: the server script embeds this before hydration. A fitting strip first keeps only the views that fit
 * its room and counts the rest in More; then the open or focused view scrolls into the strip.
 */
function settleViewTabs(list: Element | null, edges: (element: HTMLElement) => string | undefined, focused?: HTMLElement) {
  if (!(list instanceof HTMLElement)) return;
  const more = list.querySelector<HTMLElement>(":scope > .k2b-view-tabs__more");
  const fitCount = more?.querySelector<HTMLElement>('.k2b-view-tabs__more-count[data-level="fit"]');
  const flowing = Array.from(list.querySelectorAll<HTMLElement>(":scope > .k2b-view-tabs__item:not([data-pinned])"));

  for (const item of flowing) item.removeAttribute("data-fit-hidden");
  more?.removeAttribute("data-fit");
  // The shown entries against the strip's inner room, whatever its scroll and padding.
  const overflows = () => {
    const boxes = Array.from(list.children)
      .filter((child) => child instanceof HTMLElement && child.tagName === "LI" && child.getClientRects().length > 0)
      .map((child) => child.getBoundingClientRect());
    if (boxes.length === 0) return false;
    const style = getComputedStyle(list);
    const room = list.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    return Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left)) > room + 0.5;
  };
  // The phone head row keeps its scrolling strip: its CSS turns fitting off.
  const fits = list.hasAttribute("data-fit-room") && getComputedStyle(list).getPropertyValue("--k2b-view-tabs-fit").trim() !== "none";
  if (fits && more && fitCount && overflows()) {
    // Count from the level on screen: the compact strip already keeps fewer views than the wide one.
    const compact = more.querySelector<HTMLElement>('.k2b-view-tabs__more-count[data-level="compact"]');
    const compactShown = Boolean(compact && getComputedStyle(compact).display !== "none");
    const behind = Number(compactShown ? more.dataset.behindCompact : more.dataset.behindWide) || 0;
    // The last views on screen leave first; the open view stays.
    const candidates = flowing.filter((item) => item.getClientRects().length > 0 && !item.querySelector("[aria-current=page]")).reverse();
    more.setAttribute("data-fit", "");
    let hidden = 0;
    for (const item of candidates) {
      item.setAttribute("data-fit-hidden", "");
      hidden += 1;
      fitCount.textContent = `+${behind + hidden}`;
      if (!overflows()) break;
    }
    if (hidden === 0) more.removeAttribute("data-fit");
  }
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
  __k2bViewTabsWatch?: {
    resize: ResizeObserver;
    focus: (event: FocusEvent) => void;
    preferCurrent: boolean;
    connect: () => void;
    /** Runs one fit in the next frame; calls before it runs share it. */
    schedule: () => void;
    frame: number;
    /** The head lead's width and the widths of the shown entries when the last fit ended. */
    room: string;
    /** Fits again once web fonts finish loading: their metrics change every view's width, not the lead's. */
    fonts: () => void;
  };
};

/**
 * Also embedded, so it must not close over module state.
 *
 * A fitting strip converges by construction. It fits again only when the strip renders, web fonts finish loading, or
 * a notification finds another width of the head lead or of an entry that the last fit left shown. A fit only shows
 * and hides entries: the lead is an inline-size container that takes no width from the strip, and every entry keeps
 * its own width (`flex: none`), so the notifications a fit causes find the widths it ended with and stop there.
 */
function watchViewTabs(list: WatchedViewTabs | null, settle: typeof settleViewTabs, edges: (element: HTMLElement) => string | undefined) {
  if (!(list instanceof HTMLElement)) return;
  const fits = list.hasAttribute("data-fit-room");
  const roomOf = () => list.closest<HTMLElement>(".k2b-app-workspace__head-lead");
  // What a fit depends on: the lead's width and each shown entry's width, which fonts, icons and labels change.
  const measured = () =>
    [roomOf()?.clientWidth ?? -1, ...Array.from(list.children, (child) => child.getBoundingClientRect().width)].join(" ");
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
    const settleNow = () => {
      const focused = document.activeElement;
      if (
        watch?.preferCurrent === false &&
        focused instanceof HTMLElement &&
        list.contains(focused) &&
        focused.matches(".k2b-view-tabs__tab:focus-visible")
      )
        settle(list, edges, focused);
      else settle(list, edges);
    };
    // Head actions parse after the views; settle again after their layout, before paint, and on later resizes.
    const connect = () => {
      if (!watch) return;
      watch.resize.disconnect();
      watch.resize.observe(list);
      for (const child of Array.from(list.children)) watch.resize.observe(child);
      const room = roomOf();
      if (fits && room) watch.resize.observe(room);
    };
    // Fitting resizes the strip and possibly the head, which other observers may watch. Inside a ResizeObserver
    // callback that would leave their notifications undelivered, so a fit runs in the next frame, still before it paints.
    const schedule = () => {
      if (!watch || watch.frame) return;
      watch.frame = requestAnimationFrame(() => {
        if (!watch) return;
        watch.frame = 0;
        if (!list.isConnected) return;
        settleNow();
        watch.room = measured();
      });
    };
    watch = {
      resize: new ResizeObserver(() => {
        // A scrolling strip only scrolls and settles at once.
        if (!fits) return settleNow();
        // Heights follow the fit, and hidden entries measure 0 by its own doing: only another measure counts.
        if (watch && measured() !== watch.room) watch.schedule();
      }),
      focus,
      preferCurrent: true,
      connect,
      schedule,
      frame: 0,
      room: "",
      fonts: () => watch?.schedule(),
    };
    Object.defineProperty(list, "__k2bViewTabsWatch", { value: watch, configurable: true });
    list.addEventListener("focusin", focus);
    // A first visit can paint before the web fonts load; the server frame and the client then fit the same metrics.
    if (fits && document.fonts) {
      document.fonts.addEventListener("loadingdone", watch.fonts);
      void document.fonts.ready.then(watch.fonts);
    }
  }
  watch.preferCurrent = true;
  watch.connect();
  settle(list, edges);
  if (fits) {
    watch.room = measured();
    // The head's actions parse after the views. A frame's animation callbacks run before its first layout and
    // paint, so this fit also counts their room in the first frame.
    watch.schedule();
  }
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
    let disposed = false;
    // Later mount effects can invalidate WebKit's scroll layout after this
    // initial settle. Finish once the mount task is complete, before its first
    // frame; ResizeObserver alone runs too late for that frame.
    queueMicrotask(() => {
      if (!disposed && watch?.preferCurrent) settleViewTabs(list ?? null, scrollFadeEdges);
    });
    onCleanup(() => {
      disposed = true;
      watch?.resize.disconnect();
      if (watch?.frame) cancelAnimationFrame(watch.frame);
      if (watch) document.fonts?.removeEventListener("loadingdone", watch.fonts);
      if (list && watch) {
        list.removeEventListener("focusin", watch.focus);
        Reflect.deleteProperty(list, "__k2bViewTabsWatch");
      }
    });
  });
  // User effects run after Solid's render effects, including For and aria-current, in the same task.
  // What the strip shows: another open view, view, label, count or badge can change what fits. Equal content in a new
  // array settles nothing again.
  const shown = createMemo(() =>
    [
      props.current ?? "",
      layout().wide.join(","),
      ...props.items.map((item) => `${item.id}\u0000${item.label}\u0000${item.count ?? ""}\u0000${item.badge ?? ""}`),
    ].join("\u0001"),
  );
  createEffect(on(shown, () => watchViewTabs(list ?? null, settleViewTabs, scrollFadeEdges), { defer: true }));
  const [open, setOpen] = createSignal(false);
  const [menuItems, setMenuItems] = createSignal<DropdownItem[]>([]);
  const onOpenChange = (next: boolean) => {
    if (next) {
      setMenuItems(
        props.items
          .filter(
            (item, index) =>
              !item.pinned &&
              item.id !== props.current &&
              (!layout().wide.includes(index) || stripItems.get(index)?.getClientRects().length === 0),
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
      <Show when={item.badge}>{(badge) => <span class="k2b-view-tabs__badge">{badge()}</span>}</Show>
    </>
  );
  const stripItem = (index: number) => {
    const item = () => props.items[index]!;
    onCleanup(() => stripItems.delete(index));
    return (
      <li
        ref={(element) => stripItems.set(index, element)}
        class="k2b-view-tabs__item"
        data-view-tab={item().id}
        data-pinned={item().pinned ? "" : undefined}
        data-compact-hidden={!item().pinned && !layout().compact.includes(index) ? "" : undefined}
      >
        <a class="k2b-view-tabs__tab" href={item().href} aria-current={item().id === props.current ? "page" : undefined}>
          {tabContent(item())}
        </a>
      </li>
    );
  };
  return (
    <nav class={`k2b-view-tabs ${props.class ?? ""}`} aria-label={props.label}>
      <ul
        ref={list}
        class="k2b-view-tabs__list"
        data-scroll-fade-mode="both"
        data-scroll-fade-axis="horizontal"
        data-fit-room={props.fit ? "" : undefined}
      >
        <For each={layout().wide}>{stripItem}</For>
        {/* A fitting strip keeps More ready, hidden until a view leaves the strip. */}
        <Show when={layout().compactHidden + layout().wideHidden > 0 || (props.fit && layout().wide.length > 1)}>
          <li
            class="k2b-view-tabs__more"
            data-wide={layout().wideHidden > 0 ? "" : undefined}
            data-behind-wide={layout().wideHidden}
            data-behind-compact={layout().compactHidden}
          >
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
                {/* Written by the strip's fit, never by the render, so a rerender keeps the count it measured. */}
                <span class="k2b-view-tabs__more-count" data-level="fit" />
                <i class="ti ti-chevron-down" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </li>
        </Show>
        <For each={layout().pinned}>{stripItem}</For>
      </ul>
      <script innerHTML={VIEW_TABS_SCRIPT} />
    </nav>
  );
}
