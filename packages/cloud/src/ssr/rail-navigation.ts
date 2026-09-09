import type { RailPreferences } from "../contracts/rail-preferences";

export type RailApp = {
  id: string;
  iconClass: string;
  label: string;
  href: string;
  match: string;
  defaultVisible: boolean;
  description?: string;
  accent?: string;
};
export type RailLink = Omit<RailApp, "defaultVisible"> & { exact?: boolean };

export const isRailAppVisible = (app: RailApp, settings: RailPreferences): boolean =>
  Object.hasOwn(settings.visibility, app.id) ? (settings.visibility[app.id] ?? app.defaultVisible) : app.defaultVisible;

export const sortRailApps = (apps: readonly RailApp[], locale: string): RailApp[] => {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return [...apps].sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id, "en"));
};

/** Input is the authorized navigation catalog, never the unfiltered registry. */
export const projectRailNavigation = (apps: readonly RailApp[], settings: RailPreferences, locale: string) => {
  const catalog = new Map(apps.map((app) => [app.id, app]));
  const pinned = new Set<string>();
  const shortcuts: RailLink[] = [];
  for (const shortcut of settings.shortcuts) {
    if (shortcut.kind === "app") {
      const app = catalog.get(shortcut.appId);
      if (!app || pinned.has(app.id)) continue;
      pinned.add(app.id);
      shortcuts.push({ ...app, id: shortcut.id });
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
    apps: sortRailApps(apps, locale).filter((app) => !pinned.has(app.id) && isRailAppVisible(app, settings)),
  };
};

export const railLinkActive = (link: RailLink, currentUrl: string): boolean => {
  const current = new URL(currentUrl, "https://cloud.invalid");
  const target = new URL(link.match, current);
  if (target.origin !== current.origin) return false;
  if (link.exact) return target.pathname === current.pathname && target.search === current.search && target.hash === current.hash;
  return (
    current.pathname === target.pathname ||
    (target.pathname !== "/" && current.pathname.startsWith(`${target.pathname.replace(/\/$/, "")}/`))
  );
};
