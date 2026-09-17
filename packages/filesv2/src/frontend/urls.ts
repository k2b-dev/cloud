export function filesUrl(baseId?: string, path = "", after?: string | null) {
  const query = new URLSearchParams();
  if (baseId) query.set("base", baseId);
  if (path) query.set("path", path);
  if (after) query.set("after", after);
  return `/app/filesv2${query.size ? `?${query}` : ""}`;
}

export function adminUrl(area: "cloud" | "freeipa", kind: "users" | "groups", after?: string | null) {
  const query = new URLSearchParams({ area, kind });
  if (after) query.set("after", after);
  return `/admin/filesv2?${query}`;
}

export function pathCrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}
