import { type CodeCheckedVersionManifest, type CodePageLinks, codeOwnPath, matchCodeRoute, type User } from "@k2b/cloud/contracts";

import type { CodePermission } from "./contracts";

/** A current Code read's person and permission, including batched reads without a synthetic session. */
export type CodePageViewer = {
  codeId: string;
  person: Pick<User, "id" | "profile"> | null;
  permission: CodePermission | null;
};

/** Shared with background recipient selection, which must not admit guests either. */
export const canDescribeCodePages = (viewer: CodePageViewer | null | undefined, minimumPermission: CodePermission = "reader"): boolean =>
  viewer?.person?.profile === "user" &&
  (viewer.permission === "editor" || (minimumPermission === "reader" && viewer.permission === "reader"));

/**
 * The authorized page selection for every version read, SSR page and chat handoff. Missing viewers and guests
 * receive no links, even when an earlier Code grant still exists. Permission belongs to this exact Code read.
 * A link is not admission: callers offering Open still require the active version and active Code.
 */
export function describeCodePages(
  codeId: string,
  version: { id: string; manifest: Pick<CodeCheckedVersionManifest, "entrypoints"> },
  viewer: CodePageViewer | null,
  minimumPermission: CodePermission = "reader",
): CodePageLinks {
  if (!canDescribeCodePages(viewer, minimumPermission) || viewer?.codeId !== codeId)
    return { versionId: version.id, homeUrl: null, pages: [] };
  const entries = version.manifest.entrypoints;
  const eligible = entries.filter((candidate) => {
    const { kind, route } = candidate;
    return (
      kind === "route" &&
      route &&
      !route.public &&
      route.page !== false &&
      (route.method === "GET" || route.method === "ALL") &&
      !route.path.includes(":") &&
      entries.find((entry) => entry.kind === "route" && entry.route && matchCodeRoute(entry.route, "GET", route.path)) === candidate
    );
  });
  const home = eligible.find(({ route }) => route!.path === "/") ?? eligible[0];
  const pages = (home ? [home, ...eligible.filter((entry) => entry !== home)] : []).map(({ entrypoint, title, route }) => ({
    entrypoint,
    title: title ?? null,
    path: route!.path,
    isRoot: route!.path === "/",
    href: codeOwnPath(codeId, route!.path),
  }));
  return { versionId: version.id, homeUrl: pages[0]?.href ?? null, pages };
}
