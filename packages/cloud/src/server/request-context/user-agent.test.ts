import { expect, test } from "bun:test";
import { type BrowserCode, describeBrowser, type OsCode } from "./user-agent";

const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const chromeHints = '"Chromium";v="130", "Google Chrome";v="130", "Not-A.Brand";v="99"';
type Case = [string, string, BrowserCode, OsCode, string?, string?];
const cases: Case[] = [
  ["Chrome Windows", chrome, "chrome", "windows"],
  ["Chrome hints", chrome, "chrome", "windows", chromeHints, '"Windows"'],
  [
    "Chrome Mac hints",
    chrome.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"),
    "chrome",
    "macos",
    chromeHints,
    '"macOS"',
  ],
  ["Chrome Mac UA", chrome.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"), "chrome", "macos"],
  ["Firefox Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0", "firefox", "windows"],
  ["Firefox Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0", "firefox", "macos"],
  ["Firefox Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "firefox", "linux"],
  ["Firefox Android", "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0", "firefox", "android"],
  ["FxiOS", iphone.replace("Version/18.0", "FxiOS/132.0"), "firefox", "ios"],
  ["Safari Mac or desktop iPad", macSafari, "safari", "mac-or-ipad"],
  ["Safari iPhone", iphone, "safari", "ios"],
  ["Safari iPad mobile", iphone.replaceAll("iPhone", "iPad"), "safari", "ios"],
  ["CriOS iPhone", iphone.replace("Version/18.0", "CriOS/130.0.6723.90"), "chrome", "ios"],
  ["CriOS desktop iPad", macSafari.replace("Version/18.0", "CriOS/130.0"), "chrome", "mac-or-ipad"],
  ["FxiOS desktop iPad", macSafari.replace("Version/18.0", "FxiOS/132.0"), "firefox", "mac-or-ipad"],
  ["Edge desktop iPad", macSafari.replace("Version/18.0", "EdgiOS/130.0"), "edge", "mac-or-ipad"],
  ["Opera desktop iPad", macSafari.replace("Version/18.0", "OPiOS/2.2"), "opera", "mac-or-ipad"],
  ["Edge UA", `${chrome} Edg/130.0.2849.46`, "edge", "windows"],
  ["Edge hints", chrome, "edge", "windows", '"Chromium";v="130", "Microsoft Edge";v="130"', '"Windows"'],
  ["Edge Android", `${android} EdgA/130.0.2849.46`, "edge", "android"],
  ["Legacy Edge", `${chrome} Edge/18.19045`, "edge", "windows"],
  ["Samsung UA", `${android} SamsungBrowser/26.0`, "samsung", "android"],
  ["Samsung hints", android, "samsung", "android", '"Chromium";v="130", "Samsung Internet";v="26"', '"Android"'],
  ["Opera UA", `${chrome} OPR/115.0.5322.68`, "opera", "windows"],
  ["Opera hints", chrome, "opera", "windows", '"Chromium";v="130", "Opera";v="115"'],
  ["Opera GX hints", chrome, "opera", "windows", '"Chromium";v="130", "Opera GX";v="115"'],
  ["Chrome OS UA", chrome.replace("Windows NT 10.0; Win64; x64", "X11; CrOS x86_64 16093.68.0"), "chrome", "chromeos"],
  ["Chrome OS hints", "", "chrome", "chromeos", chromeHints, '"Chrome OS"'],
  ["Chromium OS hints", "", "chrome", "chromeos", chromeHints, '"Chromium OS"'],
  ["Brave", chrome, "other", "windows", '"Chromium";v="130", "Brave";v="130"'],
  ["Yandex even with Google brand", chrome, "other", "windows", `${chromeHints}, "Yandex";v="24"`],
  ["Chromium and GREASE", chrome, "chrome", "windows", '"Not A;Brand";v="99", "Chromium";v="130"'],
  ["Unknown platform uses UA", chrome, "edge", "windows", '"Microsoft Edge";v="130"', '"Unknown"'],
  ["Platform hints only", iphone, "safari", "macos", undefined, '"macOS"'],
  ["Linux hints", "", "other", "linux", undefined, '"Linux"'],
  ["iOS hints", "", "other", "ios", undefined, '"iOS"'],
  ["empty", "", "other", "other"],
];
for (const [name, ua, browser, os, brands, platform] of cases)
  test(name, () => {
    const headers = new Headers({ "user-agent": ua });
    if (brands) headers.set("sec-ch-ua", brands);
    if (platform) headers.set("sec-ch-ua-platform", platform);
    expect(describeBrowser(headers)).toEqual({ browser, os });
  });

test("missing and hostile headers are bounded", () => {
  expect(describeBrowser(new Headers())).toEqual({ browser: "other", os: "other" });
  for (const [header, content] of [
    ["user-agent", "x".repeat(1024 * 1024) + chrome],
    ["sec-ch-ua", '"'.repeat(1024 * 1024)],
    ["sec-ch-ua", '"Not-A.Brand";v="99",'.repeat(2000) + '"Google Chrome";v="130"'],
    ["sec-ch-ua", ",".repeat(16) + '"Google Chrome";v="130"'],
    ["sec-ch-ua", "x".repeat(256) + '"Google Chrome";v="130"'],
    ["sec-ch-ua", '\u0001"Unbalanced;v="99"'],
  ]) {
    const start = performance.now();
    expect(describeBrowser(new Headers({ [header!]: content! }))).toEqual({ browser: "other", os: "other" });
    expect(performance.now() - start).toBeLessThan(1000);
  }
});
