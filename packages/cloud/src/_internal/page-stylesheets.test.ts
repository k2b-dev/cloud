import { expect, test } from "bun:test";
import { pageScopeClass, pageStylesheetLinks, servedStylesheets } from "./page-stylesheets";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const input = { appStylesheet: "/public/venue/app.css", appVersion: "abc", sharedVersion: "sha-1" };

test("a page without the flag links exactly the four sheets it always did, in the same order", () => {
  expect(hrefs(pageStylesheetLinks(input))).toEqual([
    "/public/fonts.css?v=sha-1",
    "/public/tabler-icons.css?v=sha-1",
    "/public/venue/app.css?v=abc",
    "/public/global.css?v=sha-1",
  ]);
});

test("a v2 page without the shell links Core's v2.css in place of global.css", () => {
  expect(hrefs(pageStylesheetLinks({ ...input, stylesheets: "v2" }))).toEqual([
    "/public/fonts.css?v=sha-1",
    "/public/tabler-icons.css?v=sha-1",
    "/public/venue/app.css?v=abc",
    "/public/v2.css?v=sha-1",
  ]);
  expect(pageStylesheetLinks({ ...input, stylesheets: "v2" })).not.toContain("global.css");
});

test("without versions the hrefs stay plain", () => {
  expect(
    hrefs(
      pageStylesheetLinks({ appStylesheet: "/public/venue/app.css", appVersion: undefined, sharedVersion: undefined, stylesheets: "v2" }),
    ),
  ).toEqual(["/public/fonts.css", "/public/tabler-icons.css", "/public/venue/app.css", "/public/v2.css"]);
});

test("v2.css only when the registered Core serves it; an older Core keeps global.css", () => {
  const core = ["/public/fonts.css", "/public/global.css", "/public/v2.css"];
  const olderCore = ["/public/fonts.css", "/public/global.css"];
  expect(servedStylesheets("v2", core)).toBe("v2");
  // A rolling update: this app is newer than the Core that serves the sheets.
  expect(servedStylesheets("v2", olderCore)).toBeUndefined();
  // Before the registry is read, nothing is known: stay on the sheet every Core serves.
  expect(servedStylesheets("v2", [])).toBeUndefined();
  expect(servedStylesheets(undefined, core)).toBeUndefined();
  expect(hrefs(pageStylesheetLinks({ ...input, stylesheets: servedStylesheets("v2", olderCore) }))).toContain("/public/global.css?v=sha-1");
});

test("only a page on v2.css alone makes its body the v2 scope", () => {
  expect(pageScopeClass("v2")).toBe(" k2-ui");
  expect(pageScopeClass(undefined)).toBe("");
});
