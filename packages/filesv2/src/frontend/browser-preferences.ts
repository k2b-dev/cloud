import { z } from "zod";
export const preferencesSchema = z.object({
  view: z.enum(["list", "grid"]).default("list"),
  density: z.enum(["normal", "compact"]).default("normal"),
  size: z.enum(["sm", "md", "lg"]).default("md"),
});
export type BrowserPreferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences = preferencesSchema.parse({});
export const preferencesCookie = "filesv2-view";
export function readBrowserPreferences(cookie?: string): BrowserPreferences {
  try {
    const value = cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${preferencesCookie}=`))
      ?.slice(preferencesCookie.length + 1);
    return value ? preferencesSchema.parse(JSON.parse(decodeURIComponent(value))) : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}
