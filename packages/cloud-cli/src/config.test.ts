import { describe, expect, test } from "bun:test";
import { posixLocale } from "./config";

describe("posixLocale", () => {
  test.each([
    ["de_DE.UTF-8", "de-DE"],
    ["de_CH.UTF-8@euro", "de-CH"],
    ["en_US", "en-US"],
    ["pt_BR.utf8", "pt-BR"],
    ["sr_RS@latin", "sr-RS"],
    ["de-de", "de-DE"],
    ["C", undefined],
    ["POSIX", undefined],
    ["C.UTF-8", undefined],
    ["C.utf8", undefined],
    ["C.other-charset", undefined],
    ["not_a_locale", "not-a-locale"],
    ["invalid!_locale", undefined],
    ["", undefined],
  ])("converts %s to %s", (raw, expected) => {
    expect(posixLocale({ LANG: raw })).toBe(expected);
  });

  test.each([
    [{ LC_ALL: "de_CH.UTF-8", LC_MESSAGES: "pt_BR.utf8", LANG: "en_US" }, "de-CH"],
    [{ LC_ALL: "", LC_MESSAGES: "pt_BR.utf8", LANG: "en_US" }, "pt-BR"],
    [{ LC_MESSAGES: "", LANG: "en_US" }, "en-US"],
    [{ LC_ALL: "C", LC_MESSAGES: "de_DE.UTF-8", LANG: "de_DE.UTF-8" }, undefined],
    [{ LC_ALL: "invalid!_locale", LANG: "de_DE.UTF-8" }, undefined],
    [{ LC_MESSAGES: "POSIX", LANG: "de_DE.UTF-8" }, undefined],
    [{}, undefined],
  ])("uses the first non-empty variable in %j", (env, expected) => {
    expect(posixLocale(env)).toBe(expected);
  });
});
