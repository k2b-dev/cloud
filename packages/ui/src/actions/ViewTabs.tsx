import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
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

/**
 * URL-backed object views. Every view is an ordinary document link, in the strip and under More, so reload, back,
 * and forward keep the view the URL names.
 */
export function ViewTabs(props: ViewTabsProps): JSX.Element {
  const messages = useUiMessages();
  const layout = createMemo(() => viewTabsLayout(props.items, props.current, props.max));
  const stripItems = new Map<number, HTMLLIElement>();
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
      <span class="k2b-view-tabs__label">{item.label}</span>
      <Show when={item.count !== undefined}>
        <span class="k2b-view-tabs__count">{item.count}</span>
      </Show>
    </>
  );
  return (
    <nav class={`k2b-view-tabs ${props.class ?? ""}`} aria-label={props.label}>
      <ul class="k2b-view-tabs__list">
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
    </nav>
  );
}
