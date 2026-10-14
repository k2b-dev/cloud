import { expect, test } from "bun:test";
import { nextThemePreference, THEME_CYCLE } from "./preference-controller";

test("appearance cycles from Automatic through Light and Dark back to Automatic", () => {
  expect(THEME_CYCLE).toEqual(["system", "light", "dark"]);
  expect(nextThemePreference("system")).toBe("light");
  expect(nextThemePreference("light")).toBe("dark");
  expect(nextThemePreference("dark")).toBe("system");
});
