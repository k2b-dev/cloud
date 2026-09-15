import type { SearchItem } from "../api/search/schemas";
import type { AppMeta } from "../contracts/app";

/** UI-only rows. The synthetic ref is a row key, never a readable resource. */
export type NavigationSearchItem = SearchItem & { keywords?: readonly string[] };

export const navigationSearchItems = (apps: readonly AppMeta[], visibleAppIds: readonly string[]): NavigationSearchItem[] => {
  const visible = new Set(visibleAppIds);
  return apps
    .filter((app) => visible.has(app.id))
    .flatMap((app) =>
      (app.searchLinks ?? []).map((link) => ({
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        ref: { type: "cloud.navigation", id: `${app.id}:${link.href}` },
        readable: false,
        title: link.label,
        preview: link.description,
        href: link.href,
        icon: link.icon ?? app.icon,
        priority: 0,
        keywords: link.keywords,
      })),
    );
};

export const matchNavigationSearchItems = (
  items: readonly NavigationSearchItem[],
  input: { query: string; tags: readonly string[]; appId?: string | null; requireReader?: boolean },
): NavigationSearchItem[] => {
  const query = input.query.trim().toLowerCase();
  if (input.requireReader || input.tags.length > 0 || query.length < 2) return [];
  const words = query.split(/\s+/);
  return items.filter((item) => {
    if (input.appId && item.appId !== input.appId) return false;
    const text = [item.title, item.preview ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
};
