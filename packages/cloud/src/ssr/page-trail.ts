import type { PageTrailLink, PageTrailState } from "@k2b/ui";
import type { LayoutBreadcrumb } from "./layout-runtime";

/** Path and query of a same-origin link, without a trailing slash; the hash names no other page. */
const pageOf = (href: string): string => {
  const hash = href.indexOf("#");
  const withoutHash = hash >= 0 ? href.slice(0, hash) : href;
  const queryStart = withoutHash.indexOf("?");
  const path = queryStart >= 0 ? withoutHash.slice(0, queryStart) : withoutHash;
  const query = queryStart >= 0 ? withoutHash.slice(queryStart) : "";
  return (path.length > 1 ? path.replace(/\/+$/, "") : path) + (query.length > 1 ? query : "");
};

/**
 * The page trail from a page's title array, by one rule for every app.
 *
 * The last entry is the page itself. Above it, Start (`href: "/"`) and the
 * app's own root (`href` equal to its base path) are dropped: the rail already
 * leads there. So is an entry without an `href`, because nobody can go back to
 * it, and one that links to the page itself (`currentPage`, path and query). What remains are the levels below the app root, nearest last; their
 * number alone decides how the shell shows the way up, so an app never
 * chooses a form and every app with the same depth looks the same.
 */
export const derivePageTrail = (
  title: string | readonly LayoutBreadcrumb[] | undefined,
  appBasePath: string | undefined,
  fallback: string,
  currentPage?: string,
): PageTrailState => {
  if (typeof title === "string") return { title, ancestors: [] };
  const current = title?.at(-1);
  if (!title || !current) return { title: fallback, ancestors: [] };
  const base = appBasePath ? pageOf(appBasePath) : undefined;
  const self = currentPage ? pageOf(currentPage) : undefined;
  const ancestors = title
    .slice(0, -1)
    .filter((entry): entry is PageTrailLink => typeof entry.href === "string" && entry.href.length > 0)
    .filter((entry) => {
      const page = pageOf(entry.href);
      return page !== "/" && page !== "" && page !== base && page !== self;
    })
    .map((entry) => ({ title: entry.title, href: entry.href }));
  return { title: current.title, ancestors };
};
