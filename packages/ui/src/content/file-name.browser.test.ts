import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// #3965: the stem and the ending are two flex items, and an accessible name joins flex items with a space, so a
// heading read "Notes .txt". The whole name must be one word for assistive technology, shortened or not.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "file-name.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { FileName } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
for (const [id, name] of [["short", "Notes.txt"], ["long", "Quarterly report for the supervisory board 2026.pdf"], ["plain", "README"]])
  render(() => createComponent(FileName, { name }), document.getElementById(id));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the file name fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a file name reads as one word in a heading, also when it is shortened, and keeps its layout", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">` +
        '<h2 id="short"></h2><h2 id="long" style="width:180px"></h2><h2 id="plain"></h2></body></html>',
    );
    await page.addScriptTag({ content: script });
    await page.locator("#plain .k2b-file-name").waitFor();
    await settled(page);
    for (const name of ["Notes.txt", "Quarterly report for the supervisory board 2026.pdf", "README"])
      expect(await page.getByRole("heading", { name, exact: true }).count()).toBe(1);
    // The shortened name still shows its ending, and the screen-reader text adds no width: the name is exactly as wide
    // as its two visible parts.
    const long = await page.locator("#long .k2b-file-name").evaluate((element) => {
      const width = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().width;
      return {
        shortened: element.querySelector(".k2b-file-name__stem")!.scrollWidth > width(".k2b-file-name__stem") + 0.5,
        ending: element.querySelector(".k2b-file-name__ext")!.textContent,
        parts: Math.round(width(".k2b-file-name__stem") + width(".k2b-file-name__ext")),
        whole: Math.round(element.getBoundingClientRect().width),
      };
    });
    expect(long).toMatchObject({ shortened: true, ending: ".pdf" });
    expect(long.parts).toBe(long.whole);
  } finally {
    await page.close();
  }
});
