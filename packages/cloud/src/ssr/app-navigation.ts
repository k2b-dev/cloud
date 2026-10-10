import { hasAnyAppRole } from "../_internal/app-roles";
import type { RuntimeAppMeta } from "../contracts/app";
import { isPwaPartId } from "../contracts/pwa-paths";
import type { User } from "../contracts/shared";
import { resolveAppPresentation } from "../shared/app-presentation";

export type VisibleNavigationApp = RuntimeAppMeta & {
  nav: NonNullable<RuntimeAppMeta["nav"]>;
};

export type RuntimeRouteMatch = {
  app: RuntimeAppMeta;
  prefix: string;
};

/** Resolves the app owning the most specific registered prefix for a path. */
export const resolveRuntimeRoute = (apps: readonly RuntimeAppMeta[], pathname: string): RuntimeRouteMatch | undefined => {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  return apps
    .flatMap((app) => app.routes.map((prefix) => ({ app, prefix })))
    .filter(({ prefix }) => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
};

/** True when a path is owned by an app other than the current caller. */
export const hasDedicatedRuntimeRoute = (apps: readonly RuntimeAppMeta[], pathname: string, currentAppId: string): boolean => {
  const match = resolveRuntimeRoute(apps, pathname);
  return !!match && match.app.id !== currentAppId;
};

/** Apps rendered in the navigation for a given authenticated user. */
export const visibleNavigationApps = (apps: readonly RuntimeAppMeta[], user: User | undefined): VisibleNavigationApp[] =>
  apps.filter(
    (app): app is VisibleNavigationApp =>
      !!app.nav && app.nav.section !== "hidden" && (!app.nav.requiresAuth || !!user) && hasAnyAppRole(user, app.nav.requiresRoles),
  );

export type VisiblePwaPart = RuntimeAppMeta & { pwa: NonNullable<RuntimeAppMeta["pwa"]> };

/**
 * Parts of the mobile app the user may see, localized and sorted by name. Empty without a user. The roles are
 * coarse visibility like the navigation's; part routes and services still authorize.
 */
export const visiblePwaParts = (apps: readonly RuntimeAppMeta[], user: User | undefined, locale: string): VisiblePwaPart[] => {
  if (!user) return [];
  // Like the gateway, which routes /pwa/<id> only to a valid part id that claims it.
  return apps
    .filter(
      (app): app is VisiblePwaPart =>
        !!app.pwa && isPwaPartId(app.id) && app.routes.includes(app.pwa.href) && hasAnyAppRole(user, app.pwa.requiresRoles),
    )
    .map((app) => resolveAppPresentation(app, locale))
    .sort((a, b) => a.name.localeCompare(b.name, locale) || a.id.localeCompare(b.id));
};
