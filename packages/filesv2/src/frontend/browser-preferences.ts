import { z } from "zod";

const viewSchema = z.object({ view: z.enum(["list", "grid", "tree"]).default("list"), size: z.enum(["sm", "md", "lg"]).default("md") });
export type ViewPreference = z.infer<typeof viewSchema>;
export const defaultView: ViewPreference = viewSchema.parse({});
/** One cookie keeps the view per storage base; the newest bases win so the cookie stays small. */
const cookieSchema = z.record(z.string(), viewSchema);
export const preferencesCookie = "filesv2-view";
const BASE_LIMIT = 40;
export const folderKey = (baseId: string, path: string) => `${baseId}:${path}`;
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
