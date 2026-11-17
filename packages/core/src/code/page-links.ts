import { type CodeCheckedVersionManifest, type CodePageLinks, codeOwnPath } from "@k2b/cloud/contracts";
import { codeReadModelMessages } from "./read-model/messages";

/**
 * The one page selection for the Code head and version handoffs. Call after authorizing the Code/version read.
 * Uses only the pinned checker's manifest, never source or a handler request. A link is not admission: callers
 * offering Open must still require the active version and an active Code. Older manifests keep legacy GET links.
 */
export function describeCodePages(
  codeId: string,
  version: { id: string; manifest: Pick<CodeCheckedVersionManifest, "entrypoints"> },
  locale: string,
): CodePageLinks {
  const { t } = codeReadModelMessages.resolve([locale]);
  const eligible = version.manifest.entrypoints.filter(
    ({ kind, route }) =>
      kind === "route" &&
      route &&
      !route.public &&
      route.page !== false &&
      (route.method === "GET" || route.method === "ALL") &&
      !route.path.includes(":"),
  );
  const home = eligible.find(({ route }) => route!.path === "/") ?? eligible[0];
  const pages = (home ? [home, ...eligible.filter((entry) => entry !== home)] : []).map(({ entrypoint, title, route }) => ({
    entrypoint,
    title: title ?? (route!.path === "/" ? t.homePage : route!.path),
    href: codeOwnPath(codeId, route!.path),
  }));
  return { versionId: version.id, homeUrl: pages[0]?.href ?? null, pages };
}
