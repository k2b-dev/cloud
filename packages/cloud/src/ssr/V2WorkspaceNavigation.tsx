import { createNavigation, type NavigationItem } from "@k2b/ui";
import type { MenuEntry, NavGroup, NavItem, OnNavigate } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import WorkspaceNavigationProvider from "./WorkspaceNavigationProvider";

type V2Navigation = {
  items: NavigationItem[];
  /** The entry's own way to open in place, by its link as written (a tap in the menu hands the same `href` on). */
  navigate: Map<string, OnNavigate>;
  /** What an entry without a link does, by its id. */
  click: Map<string, () => void>;
};

/**
 * The entries of a v2 `Nav` as the shell's navigation:
 * - each group with a name becomes a section; the deeds of its "…" follow its entries;
 * - an entry `nested` stands under the entry before it, always open and without a toggle, as the sidebar shows it;
 * - a folding entry (`items`) folds the same way, open while it holds the open entry;
 * - an entry's own "…" (`menu`) becomes its row's menu;
 * - symbols, counts, the open one and "something new" carry over.
 * Deeds are found by id (`click`), links by their address as written (`navigate`).
 */
const holdsCurrent = (item: NavigationItem): boolean => !!item.active || (item.children ?? []).some(holdsCurrent);

const fromNav = (groups: readonly NavGroup[], foot: readonly NavItem[]): V2Navigation => {
  const navigate = new Map<string, OnNavigate>();
  const click = new Map<string, () => void>();
  // a menu's entries as deeds of a row or a section: links stay links, the rest run their onClick (a choice its
  // onChoose); a submenu is left out, the sidebar keeps it
  const deeds = (entries: readonly MenuEntry[], prefix: string): NavigationItem[] =>
    entries.flatMap((entry, index): NavigationItem[] => {
      if (entry === "separator") return [];
      if ("title" in entry) {
        const section = entry;
        return deeds(
          section.items.map((item) => ({
            ...item,
            onClick: section.onChoose ? () => section.onChoose?.(item.value ?? item.label) : item.onClick,
          })),
          `${prefix}:${index}`,
        );
      }
      if (entry.items) return [];
      const id = `${prefix}:${index}`;
      const common = {
        id,
        label: entry.label,
        ...(entry.icon ? { icon: `ti ti-${entry.icon}` } : {}),
        ...(entry.disabled || (entry.href === undefined && !entry.onClick) ? { disabled: true } : {}),
      };
      if (entry.href !== undefined) return [{ ...common, href: entry.href }];
      const run = entry.onClick;
      if (run) click.set(id, () => void run());
      return [{ ...common, action: id }];
    });
  const entry = (item: NavItem, id: string): NavigationItem => {
    const common = {
      id,
      label: item.label,
      ...(item.icon ? { icon: `ti ti-${item.icon}` } : {}),
      ...(item.count !== undefined ? { badge: item.count } : {}),
      ...(item.current ? { active: true } : {}),
      ...(item.dot ? { unread: true } : {}),
      ...(item.menu ? { actions: deeds(item.menu, `${id}:menu`) } : {}),
    };
    if (item.items) {
      // a fold: its entries one level in, behind a toggle, open while it holds the open entry
      const children = rows(item.items, id);
      return { ...common, children, defaultExpanded: children.some(holdsCurrent) };
    }
    if (item.href !== undefined) {
      if (item.onNavigate) navigate.set(item.href, item.onNavigate);
      return { ...common, href: item.href, ...(item.onNavigate ? { navigation: "enhanced" as const } : {}) };
    }
    if (item.onClick) click.set(id, item.onClick);
    return { ...common, action: id, ...(item.onClick ? {} : { disabled: true }) };
  };
  const rows = (items: readonly NavItem[], prefix: string): NavigationItem[] => {
    const top: { item: NavigationItem; children: NavigationItem[] }[] = [];
    items.forEach((item, index) => {
      const row = entry(item, item.href ?? `${prefix}:${index}`);
      const parent = top.at(-1);
      if (item.nested && parent) parent.children.push(row);
      else top.push({ item: row, children: [] });
    });
    // nested entries stay open and have no toggle, as the sidebar always shows them
    return top.map(({ item, children }) => (children.length === 0 ? item : { ...item, children, disclosure: false as const }));
  };
  const items = groups.flatMap((group, index): NavigationItem[] => {
    const own = group.action && "items" in group.action ? deeds(group.action.items, `group:${index}:menu`) : [];
    const children = [...rows(group.items, `${index}`), ...own];
    return group.label ? [{ id: `group:${index}`, label: group.label, section: true, children }] : children;
  });
  return { items: [...items, ...rows(foot, "foot")], navigate, click };
};

export type V2WorkspaceNavigationProps = {
  /** The name of the menu, such as the open mailbox. */
  label: string;
  /** The same groups the page's v2 `Nav` shows. */
  groups: readonly NavGroup[];
  /** The same entries the `Nav` shows at its foot. */
  foot?: readonly NavItem[];
};

/**
 * A v2 page's sidebar in the shell's phone menu. On the phone a v2 `Workspace` puts its sidebar away; with this beside
 * it, the phone bar's title becomes the menu "Name ⌄" and lists the same entries, and a tap opens each entry the way
 * the sidebar does (in place through its `onNavigate`, else as a page). Render it once, inside the app's island, with
 * the data of its `Nav`.
 */
export default function V2WorkspaceNavigation(props: V2WorkspaceNavigationProps) {
  const tree = createMemo(() => fromNav(props.groups, props.foot ?? []));
  const navigation = createNavigation({
    items: () => tree().items,
    onNavigate: (event) => {
      const open = tree().navigate.get(event.href);
      return open ? open(event) : event.fallback();
    },
    onAction: (action) => tree().click.get(action)?.(),
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.label} />;
}
