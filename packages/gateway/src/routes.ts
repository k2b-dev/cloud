import { type AppRegistryEntry, isPwaPartId, PWA_AUTH_PATH, PWA_SHELL_APP_ID } from "@k2b/cloud/contracts";

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
  reason: "invalid_prefix" | "duplicate_prefix" | "reserved_prefix";
  detail: string;
};
export type AppRouteBuildResult = {
  routes: AppRoute[];
  warnings: AppRouteWarning[];
};

const ROUTER_APP_IDS = new Set(["gateway", "gateway-router"]);

// The route trie ignores empty segments, so `//pwa/x/` routes like `/pwa/x`.
// Canonicalize first, so the reserved and duplicate checks see what the trie routes.
const normalizePrefix = (prefix: string): string | null => {
  const trimmed = prefix.trim();
  if (!trimmed.startsWith("/")) return null;
  return `/${trimmed.split("/").filter(Boolean).join("/")}`;
};

// The mobile app's scope is the one exception: `/pwa` belongs to the shell,
// `/pwa/_auth` to Core and `/pwa/<id>` to app <id>. Anything else under `/pwa`
// would put a page or a service worker of one app inside another's part, so the
// gateway skips it, also for apps on an older @k2b/cloud without that guard.
const mayClaimPwaPrefix = (appId: string, prefix: string): boolean => {
  if (prefix !== "/pwa" && !prefix.startsWith("/pwa/")) return true;
  if (prefix === "/pwa") return appId === PWA_SHELL_APP_ID;
  if (prefix === PWA_AUTH_PATH) return appId === "core";
  return prefix === `/pwa/${appId}` && isPwaPartId(appId);
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

      if (!mayClaimPwaPrefix(app.id, prefix)) {
        warnings.push({
          appId: app.id,
          prefix,
          reason: "reserved_prefix",
          detail: "Only the mobile app shell, Core and the app's own part may route below /pwa.",
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
