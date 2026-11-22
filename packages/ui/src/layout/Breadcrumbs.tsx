import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { createScrollFade } from "./scroll-fade";
import { useWorkspaceMessages } from "./workspace-messages";

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

/** A path element that a fit already watches, so a second call only fits again. */
type WatchedBreadcrumbs = HTMLElement & { __k2bBreadcrumbsWatch?: { schedule: () => void; dispose: () => void } };

/**
 * Self-contained: the server embeds it right after the path, so it runs before hydration and on pages that never
 * hydrate it; the component calls it again on mount. It hides front levels behind "…" one by one until the path fits
 * its room, measured after the head's other parts are laid out (in the next frame) and again whenever the room
 * changes. Once every level above waits, the current level may shorten with an ellipsis (`data-squeezed`).
 */
function watchBreadcrumbs(element: Element | null) {
  if (!(element instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
  const nav = element as WatchedBreadcrumbs;
  if (nav.__k2bBreadcrumbsWatch) {
    nav.__k2bBreadcrumbsWatch.schedule();
    return nav.__k2bBreadcrumbsWatch;
  }
  const list = nav.querySelector<HTMLElement>(":scope > ol");
  if (!list) return;
  const fits = () => list.scrollWidth <= list.clientWidth + 0.5;
  const settle = () => {
    const more = list.querySelector<HTMLElement>(":scope > .k2b-breadcrumbs__more");
    const levels = Array.from(list.querySelectorAll<HTMLElement>(":scope > .k2b-breadcrumbs__item:not(.k2b-breadcrumbs__more)"));
    for (const level of levels) level.removeAttribute("data-fit-hidden");
    more?.setAttribute("hidden", "");
    list.removeAttribute("data-squeezed");
    let count = 0;
    while (!fits() && count < levels.length - 1) {
      levels[count]!.setAttribute("data-fit-hidden", "");
      more?.removeAttribute("hidden");
      count += 1;
    }
    if (count > 0 && count === levels.length - 1 && !fits()) list.setAttribute("data-squeezed", "");
    list.scrollLeft = getComputedStyle(list).direction === "rtl" ? -list.scrollWidth : list.scrollWidth;
  };
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(settle);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(nav);
  const watch = {
    schedule,
    dispose: () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      Reflect.deleteProperty(nav, "__k2bBreadcrumbsWatch");
    },
  };
  nav.__k2bBreadcrumbsWatch = watch;
  schedule();
  return watch;
}
const BREADCRUMBS_SCRIPT = `(${watchBreadcrumbs})(document.currentScript&&document.currentScript.previousElementSibling)`;

/**
 * A path, in a page head (`AppWorkspace.Head` `views`) or inside a dialog or panel: the levels above in quiet text,
 * the current level in strong text. It stays on one line and never scrolls (K15): when the path does not fit, the
 * front levels give way first and wait behind "…", which opens them as a menu; the current level always stays and
 * shortens with an ellipsis last. The fit runs from the server's script before hydration, so a page that never
 * hydrates the path fits too.
 */
export function Breadcrumbs(props: BreadcrumbsProps): JSX.Element {
  const messages = useWorkspaceMessages();
  let nav: HTMLElement | undefined;
  let list: HTMLOListElement | undefined;
  // The levels waiting behind "…", read from the fit when the menu opens.
  const [waiting, setWaiting] = createSignal<number[]>([]);
  createScrollFade(
    () => list,
    () => true,
  );
  onMount(() => {
    const watch = watchBreadcrumbs(nav ?? null);
    onCleanup(() => watch?.dispose());
  });
  // Another path fits again.
  createEffect(
    on(
      () => props.items.map((item) => item.label).join("\u0000"),
      () => watchBreadcrumbs(nav ?? null),
      { defer: true },
    ),
  );
  const select = (index: number) => {
    if (!props.disabled) props.onSelect?.(index);
  };
  const readWaiting = () => {
    if (!list) return;
    const levels = Array.from(list.querySelectorAll<HTMLElement>(":scope > .k2b-breadcrumbs__item:not(.k2b-breadcrumbs__more)"));
    setWaiting(levels.flatMap((level, index) => (level.hasAttribute("data-fit-hidden") ? [index] : [])));
  };
  const hiddenItems = (): DropdownItem[] =>
    waiting().flatMap((index) => {
      const item = props.items[index];
      if (!item) return [];
      return [item.href ? { label: item.label, href: item.href } : { label: item.label, action: () => select(index) }];
    });
  return (
    <>
      <nav ref={nav} class={`k2b-breadcrumbs ${props.class ?? ""}`} aria-label={props.label}>
        <ol ref={list} class="k2b-breadcrumbs__list" data-scroll-fade-mode="both" data-scroll-fade-axis="horizontal">
          <li
            class="k2b-breadcrumbs__item k2b-breadcrumbs__more"
            hidden
            onPointerDown={readWaiting}
            onKeyDown={readWaiting}
            onFocusIn={readWaiting}
          >
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
          <For each={props.items}>
            {(item, index) => {
              const current = () => index() === props.items.length - 1;
              return (
                <li class="k2b-breadcrumbs__item">
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
      <script innerHTML={BREADCRUMBS_SCRIPT} />
    </>
  );
}
