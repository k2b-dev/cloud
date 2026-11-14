import { expect, test } from "bun:test";
import { findBareContentImages } from "./codemirror-widget-buffer";

const lines = (source: string) => findBareContentImages("x.browser.test.ts", source).map((finding) => finding.line);

test("a bare img inside .cm-content is a finding", () => {
  expect(lines(`await page.locator(".cm-content img").first().waitFor();`)).toEqual([1]);
  expect(lines(`\nconst image = document.querySelector('.cm-content > div img');`)).toEqual([2]);
});

test("an image inside a named widget, or one that excludes the buffer, is fine", () => {
  expect(lines(`await page.locator(".cm-content .cm-image-widget img").waitFor();`)).toEqual([]);
  expect(lines(`await page.locator(".cm-content img:not(.cm-widgetBuffer)").waitFor();`)).toEqual([]);
  expect(lines(`await page.locator(".cm-content").click(); await page.locator("img.avatar").waitFor();`)).toEqual([]);
});
