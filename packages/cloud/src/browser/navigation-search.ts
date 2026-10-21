import { fuzzy } from "@k2b/stdlib";
import type { SearchItem } from "../api/search/schemas";
import type { AppMeta } from "../contracts/app";

/** UI-only rows. The synthetic ref is a row key, never a readable resource. */
export type NavigationSearchItem = SearchItem & { keywords?: readonly string[]; kind?: "app" };

export const navigationSearchItems = (
  apps: readonly (Pick<AppMeta, "id" | "name" | "icon" | "searchLinks"> & { nav?: Pick<NonNullable<AppMeta["nav"]>, "href"> })[],
  visibleAppIds: readonly string[],
): NavigationSearchItem[] => {
  const visible = new Set(visibleAppIds);
  return apps
    .filter((app) => visible.has(app.id))
    .flatMap((app) => {
      const entryLinks = app.searchLinks?.filter((link) => link.href === app.nav?.href) ?? [];
      const links = [
        ...(app.nav
          ? [
              {
                label: app.name,
                href: app.nav.href,
                icon: app.icon,
                kind: "app" as const,
                keywords: entryLinks.flatMap((link) => [link.label, ...(link.keywords ?? [])]),
              },
            ]
          : []),
        ...(app.searchLinks ?? []),
      ];
      return links.map(
        (link): NavigationSearchItem => ({
          appId: app.id,
          appName: app.name,
          appIcon: app.icon,
          ref: { type: "cloud.navigation", id: `${app.id}:${link.href}` },
          readable: false,
          title: link.label,
          preview: "description" in link ? link.description : undefined,
          href: link.href,
          icon: link.icon ?? app.icon,
          priority: 0,
          keywords: link.keywords,
          kind: "kind" in link ? link.kind : undefined,
        }),
      );
    });
};

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Compare individual names/aliases, never their combined length or number. */
const appMatchRank = (item: NavigationSearchItem, query: string): number => {
  const names = [item.title, ...(item.keywords ?? [])].map(normalize);
  if (names.includes(query)) return 0;
  const words = query.split(" ");
  if (names.some((name) => words.every((word) => name.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(word))))) return 1;
  if (names.some((name) => words.every((word) => name.includes(word)))) return 2;
  // Whole-name typos only, at least 80% similarity. No short abbreviations or description fuzzing globally.
  if (query.length < 4) return Infinity;
  const closest = fuzzy.closest(query, names, { maxDistance: query.length >= 8 ? 2 : 1 });
  return closest && closest.similarity >= 0.8 ? 3 + closest.distance / 10 : Infinity;
};

export const matchNavigationSearchItems = (
  items: readonly NavigationSearchItem[],
  input: { query: string; tags: readonly string[]; appId?: string | null; requireReader?: boolean },
): NavigationSearchItem[] => {
  const query = normalize(input.query);
  if (input.requireReader || input.tags.length > 0 || (!input.appId && query.length < 2)) return [];
  const seen = new Set<string>();
  const uniqueTarget = (item: NavigationSearchItem) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  };
  if (input.appId) {
    // App contexts keep browsing their static pages; app launchers belong to global navigation only.
    const scoped = items.filter((item) => item.appId === input.appId && item.kind !== "app");
    return query
      ? fuzzy
          .filter(query, scoped, { key: (item) => [item.title, item.preview ?? "", ...(item.keywords ?? [])].join(" ") })
          .map((hit) => hit.item)
          .filter(uniqueTarget)
      : scoped.filter(uniqueTarget);
  }
  const words = query.split(" ");
  // Deduplicate only this global view. A cross-app page still belongs to its declaring app's own scope.
  const appTargets = new Set(items.filter((item) => item.kind === "app").map((item) => item.href));
  return items
    .filter((item) => item.kind === "app" || !appTargets.has(item.href))
    .flatMap((item) => {
      const rank =
        item.kind === "app"
          ? appMatchRank(item, query)
          : words.every((word) => [item.title, item.preview ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase().includes(word))
            ? 2
            : Infinity;
      return Number.isFinite(rank) ? [{ item, rank }] : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item)
    .filter(uniqueTarget);
};
