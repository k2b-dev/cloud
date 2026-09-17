import type { Configuration } from "../contracts";
import { FilesError } from "./errors";

export function relativePath(value: string, allowEmpty = true): string {
  if (value === "" && allowEmpty) return "";
  if (!value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || value.endsWith("/"))
    throw new FilesError("invalid_path");
  if (value.split("/").some((part) => !part || part === "." || part === ".." || part === ".filegate")) throw new FilesError("invalid_path");
  return value;
}
export const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/") || ".";
export function userPath(value: string): string {
  const path = relativePath(value);
  if (path.split("/")[0] === "trash") throw new FilesError("reserved_path", 403);
  return path;
}
export function validateConfiguration(config: Configuration): void {
  if (config.url) {
    const url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new FilesError("invalid_configuration");
  }
  for (const area of [config.cloud, config.freeipa]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(area.root)) throw new FilesError("invalid_configuration");
    relativePath(area.prefix);
    const paths = [area.homes, area.groups, area.archive].map((path) => relativePath(path, false));
    for (let i = 0; i < paths.length; i++)
      for (let j = i + 1; j < paths.length; j++) {
        const a = paths[i]!;
        const b = paths[j]!;
        if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) throw new FilesError("overlapping_paths");
      }
  }
  if (config.cloud.enabled && config.freeipa.enabled && config.cloud.root === config.freeipa.root)
    throw new FilesError("overlapping_roots");
}
