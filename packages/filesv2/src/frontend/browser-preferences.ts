import { z } from "zod";

const viewSchema = z.object({ view: z.enum(["list", "grid", "tree"]).default("list"), size: z.enum(["sm", "md", "lg"]).default("md") });
export type ViewPreference = z.infer<typeof viewSchema>;
export const defaultView: ViewPreference = viewSchema.parse({});
/** One cookie keeps the view per folder; the newest folders win so the cookie stays small. */
const cookieSchema = z.record(z.string(), viewSchema);
export const preferencesCookie = "filesv2-view";
const FOLDER_LIMIT = 40;
export const folderKey = (baseId: string, path: string) => `${baseId}:${path}`;

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
export function viewFor(preferences: Record<string, ViewPreference>, baseId: string, path: string): ViewPreference {
  return preferences[folderKey(baseId, path)] ?? defaultView;
}
export function withView(preferences: Record<string, ViewPreference>, baseId: string, path: string, view: ViewPreference) {
  const next = { ...preferences };
  delete next[folderKey(baseId, path)];
  const entries = [...Object.entries(next), [folderKey(baseId, path), view] as const].slice(-FOLDER_LIMIT);
  return Object.fromEntries(entries);
}
