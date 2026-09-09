import type { AppRegistryEntry } from "@k2b/cloud/contracts";

// ─── Route table from registry ──────────────────────────────────────────────
//
// Each app declares its own top-level URL prefixes via `defineApp({ routes })`.
// The gateway is dumb: it just builds a longest-prefix-match trie from the
// declared strings and proxies to the right `baseUrl`. No derivation, no
// special cases — apps own the convention, the gateway owns nothing.
//
// Standard apps follow a four-prefix convention (`/api/<id>`, `/app/<id>`,
// `/admin/<id>`, `/public/<id>`). Specials (core, oauth, gateway-ops) list
// whatever top-level paths they actually own (e.g. `/auth`, `/oauth`,
// `/.well-known/openid-configuration`, `/legal/terms`, `/`).

export type AppRoute = { prefix: string; appId: string; baseUrl: string };
export type AppRouteWarning = {
  appId: string;
  prefix: string;
  reason: "invalid_prefix" | "duplicate_prefix";
  detail: string;
};
export type AppRouteBuildResult = {
  routes: AppRoute[];
  warnings: AppRouteWarning[];
};

const ROUTER_APP_IDS = new Set(["gateway", "gateway-router"]);

const normalizePrefix = (prefix: string): string | null => {
  const trimmed = prefix.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.slice(0, -1);
  return trimmed;
};

export const buildAppRoutesDetailed = (apps: AppRegistryEntry[]): AppRouteBuildResult => {
  const warnings: AppRouteWarning[] = [];
  const seen = new Map<string, AppRoute>();
  const routes: AppRoute[] = [];

  const sortedApps = apps.filter((app) => !ROUTER_APP_IDS.has(app.id)).sort((a, b) => a.id.localeCompare(b.id));

  for (const app of sortedApps) {
    for (const rawPrefix of app.routes) {
      const prefix = normalizePrefix(rawPrefix);
      if (!prefix) {
        warnings.push({
          appId: app.id,
          prefix: rawPrefix,
          reason: "invalid_prefix",
          detail: "Route prefixes must start with '/'.",
        });
        continue;
      }

      const duplicate = seen.get(prefix);
      if (duplicate) {
        warnings.push({
          appId: app.id,
          prefix,
          reason: "duplicate_prefix",
          detail: `Already owned by ${duplicate.appId}.`,
        });
        continue;
      }

      const route = { prefix, appId: app.id, baseUrl: app.baseUrl };
      seen.set(prefix, route);
      routes.push(route);
    }
  }

  routes.sort((a, b) => a.prefix.localeCompare(b.prefix) || a.appId.localeCompare(b.appId));
  return { routes, warnings };
};

export const buildAppRoutes = (apps: AppRegistryEntry[]): AppRoute[] => buildAppRoutesDetailed(apps).routes;
