import { expect, test } from "bun:test";
import { BASE_COLORS, BASE_ICONS, BaseAppearanceSchema, BaseTimezoneSchema } from "./base-settings";

test("base settings use fixed icons, colors and IANA zones", () => {
  for (const icon of BASE_ICONS)
    for (const color of BASE_COLORS) expect(BaseAppearanceSchema.safeParse({ icon, color, timezone: "Europe/Berlin" }).success).toBe(true);
  for (const timezone of ["UTC", "Europe/Berlin", "America/New_York"]) expect(BaseTimezoneSchema.safeParse(timezone).success).toBe(true);
  for (const timezone of ["", "Mars/Colony", "+02:00"]) expect(BaseTimezoneSchema.safeParse(timezone).success).toBe(false);
  expect(BaseAppearanceSchema.safeParse({ icon: "<script>", color: "blue", timezone: "UTC" }).success).toBe(false);
  expect(BaseAppearanceSchema.safeParse({ icon: BASE_ICONS[0], color: "url(secret)", timezone: "UTC" }).success).toBe(false);
});

test("base colors use the shared UI accent palette", () => {
  expect(BASE_COLORS).toEqual(["zinc", "blue", "emerald", "amber", "red"]);
  expect(BaseAppearanceSchema.safeParse({ icon: BASE_ICONS[0], color: "green", timezone: "UTC" }).success).toBe(false);
});
