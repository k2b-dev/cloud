import type { TabBarItem } from "@k2b/ui";
import type { RailPreferences, RailSnapshot } from "../contracts/rail-preferences";
import { helpPageAppId } from "./layout-help-url";

export type RailApp = {
  id: string;
  iconClass: string;
  label: string;
  href: string;
  match: string;
  defaultVisible: boolean;
  description?: string;
  accent?: string;
  /** The app's `nav.badge` endpoint. */
  badge?: string;
};
export type RailLink = Omit<RailApp, "defaultVisible"> & { appId?: string; exact?: boolean };

export const isRailAppVisible = (app: RailApp, settings: RailPreferences): boolean =>
  Object.hasOwn(settings.visibility, app.id) ? (settings.visibility[app.id] ?? app.defaultVisible) : app.defaultVisible;

export const sortRailApps = (apps: readonly RailApp[], locale: string): RailApp[] => {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return [...apps].sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id, "en"));
};

/** Input is the authorized navigation catalog, never the unfiltered registry. */
export const projectRailNavigation = (apps: readonly RailApp[], settings: RailSnapshot, locale: string) => {
  const catalog = new Map(apps.map((app) => [app.id, app]));
  const pinned = new Set<string>();
  const shortcuts: RailLink[] = [];
  for (const shortcut of [...(settings.managedShortcuts ?? []), ...settings.shortcuts]) {
    if (shortcut.kind === "app") {
      const app = catalog.get(shortcut.appId);
      if (!app || pinned.has(app.id)) continue;
      pinned.add(app.id);
      shortcuts.push({ ...app, id: shortcut.id, appId: app.id });
    } else {
      shortcuts.push({
        id: shortcut.id,
        href: shortcut.href,
        label: shortcut.title,
        iconClass: shortcut.icon,
        match: shortcut.href,
        exact: true,
      });
    }
  }
  return {
    shortcuts,
    apps: sortRailApps(apps, locale)
      .filter((app) => !pinned.has(app.id) && isRailAppVisible(app, settings))
      .map((app) => ({ ...app, appId: app.id })),
  };
};

/** `currentPath` is the route as `pathname + search`; an absolute URL is accepted but never required. */
export const railLinkActive = (link: RailLink, currentPath: string): boolean => {
  const current = new URL(currentPath, "https://cloud.invalid");
  const helpAppId = helpPageAppId(current.pathname);
  if (helpAppId && link.appId) return link.appId === helpAppId;
  const target = new URL(link.match, current);
  if (target.origin !== current.origin) return false;
  if (link.exact) return target.pathname === current.pathname && target.search === current.search && target.hash === current.hash;
  return (
    current.pathname === target.pathname ||
    (target.pathname !== "/" && current.pathname.startsWith(`${target.pathname.replace(/\/$/, "")}/`))
  );
};

/**
 * The phone bar's apps: the rail's links in the person's order, at most `limit`. The current page's link stays in the
 * bar; when it comes later in the rail, it takes the last place, so the bar always marks where the person is.
 */
export const phoneBarLinks = (navigation: { shortcuts: RailLink[]; apps: RailLink[] }, currentPath: string, limit: number): RailLink[] => {
  const links = [...navigation.shortcuts, ...navigation.apps];
  const current = links.findIndex((link) => railLinkActive(link, currentPath));
  if (current < limit) return links.slice(0, limit);
  return [...links.slice(0, limit - 1), links[current]!];
};

/** Start and four apps fill the phone bar's five places. */
const PHONE_BAR_APPS = 4;

const underPath = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path.replace(/\/$/, "")}/`);

/**
 * The phone bar: Home, then the person's first apps in their rail order. Home leads to `/`, which opens the
 * installation's start page (`home`), so it is the open item on `/` and on that start page, unless an app in the bar
 * is open there.
 */
export const phoneBarItems = (
  navigation: { shortcuts: RailLink[]; apps: RailLink[] },
  currentPath: string,
  home: { label: string; path: string },
): TabBarItem[] => {
  const links = phoneBarLinks(navigation, currentPath, PHONE_BAR_APPS);
  const items = links.map((link) => ({
    id: link.id,
    label: link.label,
    icon: link.iconClass,
    href: link.href,
    current: railLinkActive(link, currentPath),
  }));
  const pathname = new URL(currentPath, "https://cloud.invalid").pathname;
  const start = new URL(home.path, "https://cloud.invalid").pathname;
  const atHome = pathname === "/" || (!items.some((item) => item.current) && underPath(pathname, start));
  return [
    { id: "home", label: home.label, icon: "ti ti-home", href: "/", current: atHome },
    ...items.map((item) => ({ ...item, current: !atHome && item.current })),
  ];
};
