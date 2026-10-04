import { describe, expect, test } from "bun:test";
import { profilePreferenceLocale, setLocalePreference } from "./locale-preference";

describe("profile locale preference", () => {
  test("maps German regions to German and every other request locale to English", () => {
    expect(profilePreferenceLocale("de")).toBe("de");
    expect(profilePreferenceLocale("DE-ch")).toBe("de");
    expect(profilePreferenceLocale("en-GB")).toBe("en");
    expect(profilePreferenceLocale("fr")).toBe("en");
    expect(profilePreferenceLocale("invalid_locale")).toBe("en");
  });

  test("writes the canonical Cloud locale cookie before reloading", () => {
    const events: string[] = [];
    expect(
      setLocalePreference("de", {
        writeCookie: (name, value) => events.push(`cookie:${name}=${value}`),
        reload: () => events.push("reload"),
      }),
    ).toBe("de");
    expect(events).toEqual(["cookie:cloud.locale=de", "reload"]);
  });
});
