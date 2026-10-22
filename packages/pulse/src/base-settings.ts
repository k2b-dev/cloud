import { type AccentColor, DEFAULT_ICON_OPTIONS } from "@k2b/ui";
import { z } from "zod";

// Reuse the same curated icon catalogue as @k2b/ui's IconInput.
export const BASE_ICONS = DEFAULT_ICON_OPTIONS.map((option) => option.value);
// Use the shared fixed accent palette, also used by widget and identity surfaces.
export const BASE_COLORS = ["zinc", "blue", "emerald", "amber", "red"] as const satisfies readonly AccentColor[];
export const BaseIconSchema = z.enum(BASE_ICONS);
export const BaseColorSchema = z.enum(BASE_COLORS);
export const BaseTimezoneSchema = z
  .string()
  .max(100)
  .refine((zone) => {
    if (!/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return zone.length > 0;
    } catch {
      return false;
    }
  }, "Use an IANA timezone");
export const BaseAppearanceSchema = z.object({ icon: BaseIconSchema, color: BaseColorSchema, timezone: BaseTimezoneSchema });
