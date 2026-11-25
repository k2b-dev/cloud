import { createNavigation, type NavigationItem } from "@k2b/ui";
import type { NavGroup, NavItem, OnNavigate } from "@k2b/ui/v2";
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
 * The entries of a v2 `Nav` as the shell's navigation: each group with a name becomes a section, an entry `nested`
 * stands under the entry before it, and symbols, counts, the open one and "something new" carry over. The action of a
 * group (its "…") stays in the sidebar.
 */
const fromNav = (groups: readonly NavGroup[], foot: readonly NavItem[]): V2Navigation => {
  const navigate = new Map<string, OnNavigate>();
  const click = new Map<string, () => void>();
  const entry = (item: NavItem, id: string): NavigationItem => {
    const common = {
      id,
      label: item.label,
      icon: `ti ti-${item.icon}`,
      ...(item.count !== undefined ? { badge: item.count } : {}),
      ...(item.current ? { active: true } : {}),
      ...(item.dot ? { unread: true } : {}),
    };
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
    // nested entries stay open, as the sidebar always shows them
    return top.map(({ item, children }) => (children.length === 0 ? item : { ...item, children }));
  };
  const items = groups.flatMap((group, index): NavigationItem[] =>
    group.label
      ? [{ id: `group:${index}`, label: group.label, section: true, children: rows(group.items, `${index}`) }]
      : rows(group.items, `${index}`),
  );
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
