import { expect, test } from "bun:test";
import { authMessages, scopeLabel } from "./i18n";

test("English and German catalogs are complete", () => {
  expect(authMessages.check()).toEqual([]);
});

test("browser language preferences resolve regional and unsupported locales", () => {
  expect(authMessages.resolve(["de-CH", "en"]).t.emptyTitle).toBe("Noch keine Cloud verbunden");
  expect(authMessages.resolve(["fr", "de"]).locale).toBe("de");
  expect(authMessages.resolve(["fr"]).locale).toBe("en");
  expect(authMessages.resolve([]).t.emptyTitle).toBe("No Cloud connected yet");
});

for (const locale of ["en", "de"]) {
  test(`scope labels use the ${locale} catalog and preserve unknown codes`, () => {
    const t = authMessages.resolve([locale]).t;
    for (const [scope, word] of [
      ["read", t.scopeRead],
      ["write", t.scopeWrite],
      ["offline_access", t.scopeOffline],
      ["openid", t.scopeOpenId],
      ["profile", t.scopeProfile],
      ["email", t.scopeEmail],
      ["groups", t.scopeGroups],
      ["admin", t.scopeAdmin],
      ["files:sync", "files:sync"],
    ] as const) {
      expect(scopeLabel(scope, t)).toBe(word);
    }
  });
}
