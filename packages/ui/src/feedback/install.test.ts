import { expect, test } from "bun:test";
import { installationPlatform } from "./install";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const SAFARI = `${IOS} Version/18.0 Mobile/15E148 Safari/604.1`;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)";
const iphone = (userAgent: string) => installationPlatform(userAgent, "iPhone", 5);

test("Safari on iPhone and iPad gets the Share steps, also an iPad that reports a Mac", () => {
  expect(iphone(SAFARI)).toBe("apple-mobile");
  const desktopIpad =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  expect(installationPlatform(desktopIpad, "MacIntel", 5)).toBe("apple-mobile");
  expect(installationPlatform(desktopIpad, "MacIntel", 0)).toBe("apple-desktop");
});

test("other browsers on iPhone install through their Share menu", () => {
  expect(iphone(`${IOS} CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1`)).toBe("apple-browser");
  expect(iphone(`${IOS} FxiOS/132.0 Mobile/15E148 Safari/605.1.15`)).toBe("apple-browser");
  expect(iphone(`${IOS} Version/18.0 EdgiOS/131.0.2903.68 Mobile/15E148 Safari/605.1.15`)).toBe("apple-browser");
  expect(iphone(`${IOS} Version/18.0 Mobile/15E148 Safari/604.1 Ddg/18.0`)).toBe("apple-browser");
});

test("apps that show the page in their own view on iPhone cannot install", () => {
  expect(iphone(`${IOS} Mobile/15E148 Instagram 350.0.0.0.0 (iPhone14,5; iOS 18_0)`)).toBe("apple-in-app");
  expect(iphone(`${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0]`)).toBe("apple-in-app");
  expect(iphone(`${IOS} Mobile/15E148 LinkedInApp/9.30`)).toBe("apple-in-app");
  // The Google app carries Safari's token, but cannot install either.
  expect(iphone(`${IOS} GSA/340.0.0 Mobile/15E148 Safari/604.1`)).toBe("apple-in-app");
  // A bare web view, such as a QR scanner or a mail app, sends no `Safari/` token.
  expect(iphone(`${IOS} Mobile/15E148`)).toBe("apple-in-app");
});

test("embedded views elsewhere get the browser warning, and lookalike words do not count", () => {
  expect(
    installationPlatform(`${ANDROID.replace("Pixel 8)", "Pixel 8; wv)")} Version/4.0 Chrome/131.0 Mobile Safari/537.36`, "Linux", 5),
  ).toBe("in-app");
  expect(installationPlatform(`${ANDROID} Chrome/131.0 Mobile Safari/537.36 Instagram 350.0`, "Linux", 5)).toBe("in-app");
  expect(installationPlatform(`${ANDROID} Chrome/131.0 Mobile Safari/537.36 Online/1`, "Linux", 5)).toBe("android");
});

test("Chrome on Android installs; other Android browsers are pointed to Chrome", () => {
  expect(installationPlatform(`${ANDROID} Chrome/131.0 Mobile Safari/537.36`, "Linux", 5)).toBe("android");
  expect(installationPlatform("Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0", "Linux", 5)).toBe("android-browser");
  expect(installationPlatform(`${ANDROID} Chrome/131.0 Mobile Safari/537.36 EdgA/131.0`, "Linux", 5)).toBe("android-browser");
});

test("Samsung Internet on Android is told apart, because Android may block the apps it installs", () => {
  const samsung = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0";
  expect(installationPlatform(`${samsung} Mobile Safari/537.36`, "Linux armv81", 5)).toBe("android-samsung");
  // Samsung Internet's own view inside another app still cannot install at all.
  expect(installationPlatform(`${samsung.replace("; K)", "; K; wv)")} Mobile Safari/537.36`, "Linux", 5)).toBe("in-app");
});

test("desktop browsers get Safari's Dock steps or the general guidance", () => {
  expect(installationPlatform("Macintosh Safari", "MacIntel", 0)).toBe("apple-desktop");
  expect(installationPlatform("Macintosh Chrome Safari", "MacIntel", 0)).toBe("generic");
  expect(installationPlatform("Unknown", "Unknown", 0)).toBe("generic");
});
