import { expect, test } from "bun:test";
import { appFaviconHref } from "./app-favicon";

test("keeps Core branding and uses generated app favicons elsewhere", () => {
  expect(appFaviconHref("core", 123)).toBe("/branding/favicon");
  expect(appFaviconHref("mail", 123)).toBe("/public/mail/favicon.svg?v=123");
  expect(appFaviconHref("core", "abc123")).toBe("/branding/favicon");
  expect(appFaviconHref("core", undefined)).toBe("/branding/favicon");
  expect(appFaviconHref("mail", "abc123")).toBe("/public/mail/favicon.svg?v=abc123");
  expect(appFaviconHref("mail", undefined)).toBe("/public/mail/favicon.svg");
  expect(appFaviconHref("mail", "a/b c")).toBe("/public/mail/favicon.svg?v=a%2Fb%20c");
});
