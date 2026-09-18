export function filesUrl(baseId?: string, path = "", after?: string | null, file?: string | null) {
  const query = new URLSearchParams();
  if (baseId) query.set("base", baseId);
  if (path) query.set("path", path);
  if (after) query.set("after", after);
  if (file) query.set("file", file);
  return `/app/filesv2${query.size ? `?${query}` : ""}`;
}

export function pathCrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}
