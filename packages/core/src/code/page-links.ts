import { type CodeCheckedVersionManifest, type CodePageLinks, codeOwnPath, matchCodeRoute } from "@k2b/cloud/contracts";

/**
 * The one page selection for the Code head and version handoffs. Call after authorizing the Code/version read.
 * Uses only the pinned checker's manifest, never source or a handler request. A link is not admission: callers
 * offering Open must still require the active version and an active Code. Older manifests keep legacy GET links.
 */
export function describeCodePages(
  codeId: string,
  version: { id: string; manifest: Pick<CodeCheckedVersionManifest, "entrypoints"> },
): CodePageLinks {
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
