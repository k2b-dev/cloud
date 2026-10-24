import type { OverviewView } from "@/overview-contracts";

const BASE = "/pwa/spaces";
const query = (view?: OverviewView) => (view && view !== "mine" ? `?view=${view}` : "");

/** The list in a view; "mine" is the default and leaves the address bare. */
export const listHref = (view?: OverviewView): string => `${BASE}${query(view)}`;

/** One task; the list beside it keeps its view in the address. */
export const taskHref = (spaceShortId: string, shortId: string, view?: OverviewView): string =>
  `${BASE}/${encodeURIComponent(spaceShortId)}/${encodeURIComponent(shortId)}${query(view)}`;

/** The task a path names, or null for the list. */
export const taskAddress = (pathname: string): { spaceShortId: string; shortId: string } | null => {
  const match = /^\/pwa\/spaces\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  return match ? { spaceShortId: decodeURIComponent(match[1]!), shortId: decodeURIComponent(match[2]!) } : null;
};
