import { expect, test } from "bun:test";
import { pageStylesheetLinks } from "./page-stylesheets";

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
