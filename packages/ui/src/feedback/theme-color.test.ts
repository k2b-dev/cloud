import { afterEach, expect, test } from "bun:test";
import { createDomTestHarness, type DomTestHarness } from "../../test/dom";
import { syncThemeColor } from "./theme-color";

let dom: DomTestHarness | undefined;
afterEach(() => dom?.cleanup());

const page = (body: string) => {
  dom = createDomTestHarness();
  dom.document.head.innerHTML =
    '<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">';
  dom.document.body.innerHTML = body;
  return dom.document;
};

const metas = (document: Document) =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => [meta.getAttribute("content"), meta.getAttribute("media")]);

test("gives the html background and every theme-color the first k2b-ui background, without media", () => {
  const document = page('<div class="k2b-ui" style="background-color: rgb(9, 13, 18)"></div>');
  syncThemeColor();
  expect(document.documentElement.style.backgroundColor).toBe("rgb(9, 13, 18)");
  expect(metas(document)).toEqual([
    ["rgb(9, 13, 18)", null],
    ["rgb(9, 13, 18)", null],
  ]);
});

test("reads an explicit root, such as a k2b-ui body after a theme change", () => {
  const document = page('<div class="k2b-ui" style="background-color: rgb(1, 2, 3)"></div>');
  document.body.style.backgroundColor = "rgb(250, 250, 250)";
  syncThemeColor(document.body);
  expect(document.documentElement.style.backgroundColor).toBe("rgb(250, 250, 250)");
  expect(metas(document)[0]).toEqual(["rgb(250, 250, 250)", null]);
});
