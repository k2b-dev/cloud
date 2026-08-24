import { describe, expect, it } from "bun:test";
import { getLocale, preferredLocale, resolveLocale } from "./locale";
import { getDateConfig } from "./time";

const context = (headers: Record<string, string>, settings?: Record<string, any>) => ({
  get: (_key: "settings") => settings,
  req: { raw: { headers: new Headers(headers) } },
});

describe("preferredLocale", () => {
  it("prefers explicit transport metadata over the cookie and Accept-Language", () => {
    const headers = new Headers({
      "x-cloud-locale": "fr",
      Cookie: "cloud.locale=de-CH",
      "Accept-Language": "en-US,en;q=0.8",
    });
    expect(preferredLocale(headers)).toBe("fr");
  });

  it("prefers the cookie over Accept-Language", () => {
    const headers = new Headers({ Cookie: "cloud.locale=de-CH", "Accept-Language": "en-US" });
    expect(preferredLocale(headers)).toBe("de-CH");
  });

  it("falls through an invalid cookie to Accept-Language quality order", () => {
    const headers = new Headers({ Cookie: "cloud.locale=???", "Accept-Language": "en;q=0.8, de-AT" });
    expect(preferredLocale(headers)).toBe("de-AT");
  });

  it("returns undefined without any preference", () => {
    expect(preferredLocale(new Headers())).toBeUndefined();
    expect(preferredLocale(new Headers({ "Accept-Language": "*" }))).toBeUndefined();
  });
});

describe("resolveLocale", () => {
  it("uses the operator default when the request carries no preference", () => {
    expect(resolveLocale(new Headers(), "de-DE")).toBe("de-DE");
  });

  it("falls back to en for an invalid operator default", () => {
    expect(resolveLocale(new Headers(), "not a locale!")).toBe("en");
    expect(resolveLocale(new Headers())).toBe("en");
  });
});

describe("getLocale", () => {
  it("resolves the request preference before the app.locale setting", () => {
    const c = context({ "Accept-Language": "fr-CH" }, { app: { locale: "de" } });
    expect(getLocale(c)).toBe("fr-CH");
  });

  it("uses the app.locale setting for preference-free requests", () => {
    expect(getLocale(context({}, { app: { locale: "de" } }))).toBe("de");
  });

  it("stays deterministic without a settings snapshot", () => {
    expect(getLocale(context({}))).toBe("en");
  });
});

describe("getDateConfig", () => {
  it("combines the canonical locale with an independent timezone", () => {
    const c = context({ "Accept-Language": "de-CH", Cookie: "cloud.timezone=Europe/Zurich" }, { app: { locale: "en", timezone: "UTC" } });
    expect(getDateConfig(c)).toEqual({ timeZone: "Europe/Zurich", locale: "de-CH", firstDayOfWeek: 1 });
  });

  it("keeps timezone and locale fallbacks separate", () => {
    const c = context({}, { app: { locale: "de-DE", timezone: "Europe/Berlin" } });
    expect(getDateConfig(c)).toEqual({ timeZone: "Europe/Berlin", locale: "de-DE", firstDayOfWeek: 1 });
  });
});
