import type { BrowseOptions } from "../contracts";
export function filesUrl(baseId?: string, path = "", after?: string | null, file?: string | null, search?: string | null, scope?: "folder" | "tree" | null, browse?: BrowseOptions) {
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
export const editorUrl = (baseId: string, path: string) => `${filesUrl(baseId, path.split("/").slice(0, -1).join("/"), null, path)}&view=edit`;

export function pathCrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}
