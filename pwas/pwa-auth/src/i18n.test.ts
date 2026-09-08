import { expect, test } from "bun:test";
import { authMessages } from "./i18n";

test("English and German catalogs are complete", () => {
  expect(authMessages.check()).toEqual([]);
});

test("browser language preferences resolve regional and unsupported locales", () => {
  expect(authMessages.resolve(["de-CH", "en"]).t.emptyTitle).toBe("Noch keine Cloud verbunden");
  expect(authMessages.resolve(["fr", "de"]).locale).toBe("de");
  expect(authMessages.resolve(["fr"]).locale).toBe("en");
  expect(authMessages.resolve([]).t.emptyTitle).toBe("No Cloud connected yet");
});
