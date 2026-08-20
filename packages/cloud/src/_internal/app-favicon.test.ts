import { expect, test } from "bun:test";
import { appFaviconHref } from "./app-favicon";

test("keeps Core branding and uses generated app favicons elsewhere", () => {
  expect(appFaviconHref("core", 123)).toBe("/branding/favicon");
  expect(appFaviconHref("mail", 123)).toBe("/public/mail/favicon.svg?v=123");
});
