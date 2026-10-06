import type { BrowseOptions } from "../contracts";
import { parseStableEntryRefId } from "../resource-ref";
export function filesUrl(
  baseId?: string,
  path = "",
  after?: string | null,
  file?: string | null,
  search?: string | null,
  scope?: "folder" | "tree" | null,
  browse?: BrowseOptions,
) {
  const query = new URLSearchParams();
  if (baseId) query.set("base", baseId);
  if (path) query.set("path", path);
  if (search) query.set("q", search);
  if (search && scope === "folder") query.set("scope", "folder");
  if (browse) for (const [key, value] of Object.entries(browse)) query.set(key, String(value));
  if (after) query.set("after", after);
  if (file) query.set("file", file);
  return `/app/filesv2${query.size ? `?${query}` : ""}`;
}

/** The editor view: the folder stays in the URL so leaving the editor returns to the file's row. */
export const editorUrl = (baseId: string, path: string) =>
  `${filesUrl(baseId, path.split("/").slice(0, -1).join("/"), null, path)}&view=edit`;

/** The plain-text link of a copied reference: a stable ref opens through the deep link, which follows renames and moves. */
export const referenceHref = (baseId: string, entry: { path: string; directory: boolean }, id: string) =>
  parseStableEntryRefId(id)
    ? `/app/filesv2/ref/${encodeURIComponent(id)}`
    : entry.directory
      ? filesUrl(baseId, entry.path)
      : filesUrl(baseId, entry.path.split("/").slice(0, -1).join("/"), null, entry.path);

export function pathCrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}
