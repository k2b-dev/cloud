/**
 * Resolving which admin sidebar link is the current one.
 *
 * Kept out of the sidebar component so it can be tested without a JSX runtime,
 * and because the rule is subtle enough to deserve its own tests.
 */

const asUrl = (path: string): URL => new URL(`http://admin.local${path}`);

/**
 * Whether a link covers the current path at all. A section link stays lit on
 * its sub-pages, which is why this is a prefix test rather than equality.
 *
 * Settings tabs live on one path and differ only by query parameter, so they
 * compare that instead.
 */
const matches = (currentPath: string, href: string): boolean => {
  const current = asUrl(currentPath);
  const target = asUrl(href);
  if (target.pathname === "/admin/settings") {
    return current.pathname === "/admin/settings" && current.searchParams.get("tab") === target.searchParams.get("tab");
  }
  return current.pathname === target.pathname || current.pathname.startsWith(`${target.pathname}/`);
};

/**
 * The most specific link covering the current path, or null if none does.
 *
 * Prefix matching applied per link lights up every ancestor: the observability
 * overview at `/admin/observability` matched all of `/admin/observability/*`,
 * so it stayed highlighted next to the page actually open. Comparing
 * candidates and keeping the longest resolves that generically — including for
 * `/admin` itself, which previously needed its own exact-match exception.
 */
export const activeAdminHref = (currentPath: string, hrefs: readonly string[]): string | null => {
  let best: string | null = null;
  let bestLength = -1;
  for (const href of hrefs) {
    if (!matches(currentPath, href)) continue;
    const length = asUrl(href).pathname.length;
    if (length > bestLength) {
      best = href;
      bestLength = length;
    }
  }
  return best;
};

/**
 * The link whose own href or one of its `match` paths covers the current path most specifically. An area link, such
 * as Observability, stays active on every page of the area.
 */
export const activeAdminLink = <Link extends { href: string; match?: readonly string[] }>(
  currentPath: string,
  links: readonly Link[],
): Link | null => {
  const candidates = links.flatMap((link) => [link.href, ...(link.match ?? [])].map((path) => ({ link, path })));
  const best = activeAdminHref(
    currentPath,
    candidates.map((candidate) => candidate.path),
  );
  return best === null ? null : (candidates.find((candidate) => candidate.path === best)?.link ?? null);
};
