import type { AppInstallable } from "@k2b/cloud/contracts";

// ─── Prefix Trie for O(segments) route matching ─────────────────────────────

export type TrieNode = {
  segment: string;
  target: string | null;
  appId: string | null;
  children: Map<string, TrieNode>;
};

export type RouteEntry = { prefix: string; appId: string };

export type RouteTable = {
  root: TrieNode;
  installables: ReadonlyArray<{ appId: string; declaration: AppInstallable }>;
  version: number;
  builtAt: number;
  routeCount: number;
  routes: RouteEntry[];
};

export type MatchResult = {
  appId: string;
  baseUrl: string;
  matchedPrefix: string;
} | null;

type AppWithRoutes = {
  prefix: string;
  appId: string;
  baseUrl: string;
  installable?: AppInstallable;
};

let tableVersion = 0;

const createNode = (segment: string): TrieNode => ({
  segment,
  target: null,
  appId: null,
  children: new Map(),
});

/**
 * Build a new immutable route table from app route entries.
 * Each entry maps a path prefix to an app's baseUrl.
 */
export const buildRouteTable = (routes: AppWithRoutes[]): RouteTable => {
  const root = createNode("");
  const installables = new Map<string, AppInstallable>();

  for (const { prefix, appId, baseUrl, installable } of routes) {
    if (installable) installables.set(appId, installable);
    const segments = prefix.split("/").filter(Boolean);
    let current = root;

    for (const seg of segments) {
      let child = current.children.get(seg);
      if (!child) {
        child = createNode(seg);
        current.children.set(seg, child);
      }
      current = child;
    }

    // Mark this node as a route endpoint
    current.target = baseUrl;
    current.appId = appId;
  }

  tableVersion++;

  return {
    root,
    installables: [...installables].map(([appId, declaration]) => ({ appId, declaration })),
    version: tableVersion,
    builtAt: Date.now(),
    routeCount: routes.length,
    routes: routes.map((r) => ({ prefix: r.prefix, appId: r.appId })),
  };
};

/**
 * Match a URL path against the route table.
 * Returns the longest matching prefix's target.
 * O(path segments) — not O(routes).
 */
export const matchRoute = (table: RouteTable, pathname: string): MatchResult => {
  const segments = pathname.split("/").filter(Boolean);
  let current = table.root;
  let bestMatch: MatchResult = null;
  const matchedSegments: string[] = [];

  // Check root-level match (e.g., "/" route)
  if (current.target) {
    bestMatch = { appId: current.appId!, baseUrl: current.target, matchedPrefix: "/" };
  }

  for (const seg of segments) {
    const child = current.children.get(seg);
    if (!child) break;

    current = child;
    matchedSegments.push(seg);
    if (current.target) {
      bestMatch = { appId: current.appId!, baseUrl: current.target, matchedPrefix: `/${matchedSegments.join("/")}` };
    }
  }

  // Never let an ancestor (including Core's / fallback) answer another app's namespace.
  if (segments[0] === "app" && segments[1] && bestMatch?.appId !== segments[1]) return null;
  return bestMatch;
};
