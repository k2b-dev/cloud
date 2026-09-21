import { z } from "zod";
import { type BrowseOptions, BrowseOptionsSchema } from "../contracts";

export const SORT_KEYS = ["name", "modified", "size"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
const viewSchema = z.object({
  view: z.enum(["list", "grid", "tree"]).default("list"),
  size: z.enum(["sm", "md", "lg"]).default("md"),
  sort: z.enum(SORT_KEYS).catch("name"),
  type: z.enum(["all", "files", "directories"]).default("all"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  groupFolders: z.boolean().default(true),
});
export type ViewPreference = z.infer<typeof viewSchema>;
export const defaultView: ViewPreference = viewSchema.parse({});
/** One cookie keeps the view per storage base; the newest bases win so the cookie stays small. */
const cookieSchema = z.record(z.string(), viewSchema);
export const preferencesCookie = "filesv2-view";
const BASE_LIMIT = 40;
export const folderKey = (baseId: string, path: string) => JSON.stringify([baseId, path]);
const baseKey = (baseId: string) => baseId;

export function parsePreferences(cookie?: string): Record<string, ViewPreference> {
  try {
    const value = cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${preferencesCookie}=`))
      ?.slice(preferencesCookie.length + 1);
    return value ? cookieSchema.parse(JSON.parse(decodeURIComponent(value))) : {};
  } catch {
    return {};
  }
}
export function viewFor(preferences: Record<string, ViewPreference>, baseId: string): ViewPreference {
  return preferences[baseKey(baseId)] ?? defaultView;
}
export function withView(preferences: Record<string, ViewPreference>, baseId: string, view: ViewPreference) {
  const next = { ...preferences };
  delete next[baseKey(baseId)];
  const entries = [...Object.entries(next), [baseKey(baseId), view] as const].slice(-BASE_LIMIT);
  return Object.fromEntries(entries);
}

/** URL wins; preferences only supply absent query fields on the first visit. */
export function browseOptions(params: URLSearchParams, preference = defaultView): BrowseOptions {
  return BrowseOptionsSchema.parse({
    sort: params.get("sort") ?? preference.sort,
    order: params.get("order") ?? preference.direction,
    type: params.get("type") ?? preference.type,
    groupFolders: params.get("groupFolders") ?? preference.groupFolders,
  });
}
export const browseQuery = (options: BrowseOptions) => ({
  ...options,
  groupFolders: options.groupFolders ? ("true" as const) : ("false" as const),
});
