import { expect, test } from "bun:test";
import { geoNavigationHref, geoNavigationPlatform } from "./navigation";

test("navigation links open the platform's maps app with only destination and name", () => {
  const target = { point: { lat: 48.39841, lon: 9.99155 }, text: "Frauenstraße 28, 89073 Ulm", name: "Jana Berger" };
  expect(geoNavigationHref(target, "android")).toBe("geo:0,0?q=48.39841,9.99155(Jana%20Berger)");
  expect(geoNavigationHref(target, "ios")).toBe("https://maps.apple.com/?daddr=48.39841%2C9.99155");
  expect(geoNavigationHref(target, "desktop")).toBe("https://www.openstreetmap.org/directions?route=%3B48.39841%2C9.99155");
  const text = { text: "Frauenstraße 28, 89073 Ulm" };
  expect(geoNavigationHref(text, "android")).toBe("geo:0,0?q=Frauenstra%C3%9Fe%2028%2C%2089073%20Ulm");
  expect(geoNavigationHref(text, "ios")).toBe("https://maps.apple.com/?daddr=Frauenstra%C3%9Fe%2028%2C%2089073%20Ulm");
  expect(geoNavigationHref(text, "desktop")).toBe("https://www.openstreetmap.org/search?query=Frauenstra%C3%9Fe%2028%2C%2089073%20Ulm");
});

test("the platform follows the user agent", () => {
  expect(geoNavigationPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
  expect(geoNavigationPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)")).toBe("ios");
  expect(geoNavigationPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("desktop");
});
