import { searchParams } from "@k2b/stdlib";

/**
 * The sidebar's list filter in the address: `?view=favorites`, `?view=recents`, or `?view=tag&tag=…`. Without one the
 * sidebar shows the note tree. The address keeps the filter across reloads and note changes.
 */
export type SidebarFilter =
  | { view?: undefined; tag?: undefined }
  | { view: "favorites" | "recents"; tag?: undefined }
  | { view: "tag"; tag: string };

/** `folder` belonged to the removed Navigator; an old link with it opens the tree. */
const FILTER_KEYS = new Set(["view", "tag", "folder"]);

export const parseSidebarFilter = (params: URLSearchParams): SidebarFilter => {
  const view = params.get("view");
  if (view === "favorites" || view === "recents") return { view };
  if (view === "tag") {
    const tag = params.get("tag")?.trim().toLowerCase();
    if (tag) return { view, tag };
  }
  return {};
};

export const hasOnlySidebarFilterQuery = (params: URLSearchParams): boolean => [...params.keys()].every((key) => FILTER_KEYS.has(key));

export const withSidebarFilter = (href: string, filter: SidebarFilter): string => {
  const [pathname, rawSearch = ""] = href.split("?", 2);
  const search = searchParams.serialize(
    { view: filter.view, tag: filter.view === "tag" ? filter.tag : undefined, folder: undefined },
    new URLSearchParams(rawSearch),
  );
  return `${pathname}${search ? `?${search}` : ""}`;
};
