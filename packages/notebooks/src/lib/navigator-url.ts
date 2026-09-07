import { searchParams } from "@k2b/stdlib";
import { requestedPresentationMode, withPresentationMode } from "./presentation-url";

export type NavigatorQuery =
  | { view?: undefined; folder?: undefined; tag?: undefined }
  | { view: "favorites" | "recents"; folder?: undefined; tag?: undefined }
  | { view: "folder"; folder: string; tag?: undefined }
  | { view: "tag"; tag: string; folder?: undefined };

const NAVIGATOR_KEYS = new Set(["view", "folder", "tag"]);

/** Auxiliary pages have no note-list pane: return to the notebook before filtering. */
export const navigatorDestinationHref = (currentHref: string, notebookId: string, query: NavigatorQuery): string => {
  const current = new URL(currentHref, "https://notebooks.invalid");
  const base = `/app/notebooks/${notebookId}`;
  const isWorkspace =
    current.pathname === base ||
    (current.pathname.startsWith(`${base}/notes/`) && /^[A-Za-z0-9]{6}$/.test(current.pathname.slice(`${base}/notes/`.length)));
  const mode = requestedPresentationMode(current.searchParams);
  return withNavigatorQuery(isWorkspace ? currentHref : mode ? withPresentationMode(base, mode) : base, query);
};

export const parseNavigatorQuery = (params: URLSearchParams): NavigatorQuery => {
  const view = params.get("view");
  if (view === "favorites" || view === "recents") return { view };
  if (view === "folder") {
    const folder = params.get("folder")?.trim();
    if (folder) return { view, folder };
  }
  if (view === "tag") {
    const tag = params.get("tag")?.trim().toLowerCase();
    if (tag) return { view, tag };
  }
  return {};
};

export const hasOnlyNavigatorQuery = (params: URLSearchParams): boolean => [...params.keys()].every((key) => NAVIGATOR_KEYS.has(key));

export const withNavigatorQuery = (href: string, query: NavigatorQuery): string => {
  const [pathname, rawSearch = ""] = href.split("?", 2);
  const search = searchParams.serialize(
    {
      view: query.view,
      folder: query.view === "folder" ? query.folder : undefined,
      tag: query.view === "tag" ? query.tag : undefined,
    },
    new URLSearchParams(rawSearch),
  );
  return `${pathname}${search ? `?${search}` : ""}`;
};
