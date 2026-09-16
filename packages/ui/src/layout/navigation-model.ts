import type { LinkNavigateEvent, NavigationScrollMode } from "@k2b/ssr/nav";
import type { Accessor } from "solid-js";

type NavigationEntry = {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
  description?: string;
  active?: boolean;
  disabled?: boolean;
  color?: string;
  children?: readonly NavigationItem[];
  /** Initial disclosure state; subsequent toggles remain local to the renderer. */
  defaultExpanded?: boolean;
  actions?: readonly NavigationItem[];
};

/** Serializable presentation. Functions stay with the controller's owning island. */
export type NavigationItem = NavigationEntry &
  (
    | { href: string; action?: string; navigation?: "document" | "enhanced"; scroll?: NavigationScrollMode }
    | { action: string; href?: never; navigation?: never; scroll?: never }
    | { href?: never; action?: never; navigation?: never; scroll?: never; children: readonly NavigationItem[] }
  );

export type NavigationOptions = {
  items: Accessor<readonly NavigationItem[]>;
  onAction?: (action: string) => void | Promise<void>;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
};

export function findNavigationItem(items: readonly NavigationItem[], id: string): NavigationItem | undefined {
  for (const item of items) {
    if (item.disabled) continue;
    if (item.id === id) return item;
    const found = findNavigationItem(item.children ?? [], id) ?? findNavigationItem(item.actions ?? [], id);
    if (found) return found;
  }
}

/** One live source for renderers; no router, registry, fetching or persisted state. */
export function createNavigation(options: NavigationOptions) {
  return {
    items: options.items,
    onNavigate: options.onNavigate,
    async activate(id: string) {
      const item = findNavigationItem(options.items(), id);
      if (item?.action) await options.onAction?.(item.action);
    },
  };
}

export type NavigationController = ReturnType<typeof createNavigation>;
