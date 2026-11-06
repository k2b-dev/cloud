import type { LinkNavigateEvent, NavigationScrollMode } from "@k2b/ssr/nav";
import { type Accessor, createMemo, getOwner, runWithOwner } from "solid-js";
import type { IntentTone } from "../semantics";
import type { AppWorkspaceSidebarSwitcherProps } from "./SidebarSwitcher";

/** A status icon at a row's end, such as "running". `label` names it for screen readers and as its tooltip. */
export type NavigationStatus = { icon: string; label: string; tone?: IntentTone };

type NavigationEntry = {
  id: string;
  label: string;
  icon?: string;
  /** Names a meaningful icon for screen readers, such as "Homepage"; without it the icon is decorative. */
  iconLabel?: string;
  badge?: string | number;
  description?: string;
  /**
   * Status icon in a fixed-size slot at the row's end. Set `null` on a row whose status comes and goes: the empty slot
   * keeps its place, so a status change never rewraps the label or moves the rows below.
   */
  status?: NavigationStatus | null;
  active?: boolean;
  /** Current container, independently of its active destination. `false` quiets this row; omitted keeps the default ink. */
  context?: boolean;
  disabled?: boolean;
  color?: string;
  children?: readonly NavigationItem[];
  /** Initial disclosure state; subsequent toggles remain local to the renderer. */
  defaultExpanded?: boolean;
  /** Owner-held disclosure state. The renderer shows it and reports toggles through `onExpandedChange`. */
  expanded?: boolean;
  actions?: readonly NavigationItem[];
  /**
   * Square icon buttons in the row, before the `actions` menu. They run an `action`; a destination belongs in a row,
   * where its link keeps modified clicks and new tabs.
   */
  inlineActions?: readonly { id: string; label: string; icon: string; action: string; disabled?: boolean }[];
};

/** Serializable presentation. Functions stay with the controller's owning island. */
export type NavigationItem = NavigationEntry &
  (
    | {
        href: string;
        action?: string;
        navigation?: "document" | "enhanced";
        scroll?: NavigationScrollMode;
        section?: never;
        keepOpen?: never;
      }
    | {
        action: string;
        href?: never;
        navigation?: never;
        scroll?: never;
        section?: never;
        /**
         * Runs the action while the host's menu stays open, without `beforeSelect`. Only for an action that changes
         * what the menu shows, such as a filter or a sort order; an action that opens something lets the menu close.
         */
        keepOpen?: boolean;
      }
    | {
        href?: never;
        action?: never;
        navigation?: never;
        scroll?: never;
        keepOpen?: never;
        children: readonly NavigationItem[];
        /** Shows the group as a plain heading over its rows, always open and not indented, instead of a disclosure. */
        section?: boolean;
      }
  );

export type NavigationOptions = {
  items: Accessor<readonly NavigationItem[]>;
  /** The container the navigation works in, shown above the items with the same switcher as the sidebar's head. */
  switcher?: Accessor<AppWorkspaceSidebarSwitcherProps>;
  onAction?: (action: string) => void | Promise<void>;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  /** Receives disclosure toggles of items that carry `expanded`; the owner decides the next state. */
  onExpandedChange?: (id: string, expanded: boolean) => void;
};

export function findNavigationItem(items: readonly NavigationItem[], id: string): NavigationItem | undefined {
  for (const item of items) {
    if (item.disabled) continue;
    if (item.id === id) return item;
    const found =
      findNavigationItem(item.children ?? [], id) ??
      findNavigationItem(item.inlineActions ?? [], id) ??
      findNavigationItem(item.actions ?? [], id);
    if (found) return found;
  }
}

/** One live source for renderers; no router, registry, fetching or persisted state. */
export function createNavigation(options: NavigationOptions) {
  const owner = getOwner();
  let current: Accessor<readonly NavigationItem[]> | undefined;
  // One tree per change, however many rows read it, and none for a menu that never opens: rebuilding a mailbox's
  // 350 folders for each read took eight seconds to open the phone menu.
  const items: Accessor<readonly NavigationItem[]> = () => {
    current ??= owner ? (runWithOwner(owner, () => createMemo(options.items)) ?? options.items) : options.items;
    return current();
  };
  return {
    items,
    switcher: options.switcher,
    onNavigate: options.onNavigate,
    onExpandedChange: options.onExpandedChange,
    async activate(id: string) {
      const item = findNavigationItem(items(), id);
      if (item?.action) await options.onAction?.(item.action);
    },
  };
}

export type NavigationController = ReturnType<typeof createNavigation>;
