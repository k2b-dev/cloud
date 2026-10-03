import { For, type JSX } from "solid-js";

export type TabBarItem = {
  id: string;
  label: string;
  /** Icon class, for example `ti ti-home`. */
  icon: string;
  href: string;
  /** The page this item leads to is open. */
  current?: boolean;
};

export type TabBarProps = {
  /** Accessible name of the navigation landmark. */
  label: string;
  /** Up to five destinations; further items are not rendered. Put the rest behind a "More" destination. */
  items: readonly TabBarItem[];
  class?: string;
};

/** A phone app's bottom navigation holds at most five destinations. */
const TAB_BAR_MAX_ITEMS = 5;

/**
 * Bottom navigation between a phone app's top-level pages: native links with equal widths, an icon above each label,
 * and `aria-current="page"` on the open page. Place it in `MobileShell`'s footer; it pads the bottom safe area.
 */
export function TabBar(props: TabBarProps): JSX.Element {
  return (
    <nav class={props.class ? `k2b-tab-bar ${props.class}` : "k2b-tab-bar"} aria-label={props.label}>
      <ul>
        <For each={props.items.slice(0, TAB_BAR_MAX_ITEMS)}>
          {(item) => (
            <li>
              <a href={item.href} aria-current={item.current ? "page" : undefined} data-tab={item.id}>
                <i class={item.icon} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
}

export default TabBar;
