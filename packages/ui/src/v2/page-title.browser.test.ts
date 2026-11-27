import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-page-title.client";

// A head that changes while the page lives keeps one page heading (test/v2-page-title.client.tsx): parts that never
// stand at once each come and go in their own `Show`, so one part can come before the other has gone.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-page-title.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The headings of one Workspace: their words, and whether each is seen or only heard. */
const headings = (page: Page, workspace: "records" | "bars" | "pair") =>
  page.evaluate(
    (id) =>
      [...document.querySelectorAll(`#${id} h1`)].map(
        (h1) => `${h1.textContent}${h1.classList.contains("k2-hidden-text") ? " (heard)" : ""}`,
      ),
    workspace,
  );

const swap = async (page: Page, which: "record" | "bar" | "first") => {
  await page.evaluate((part) => window.__k2SwapHead!(part), which);
  await settled(page);
};

test("a head that swaps its record, there and back in both directions, has the record's name as its one heading", async () => {
  await withPage(async (page) => {
    expect(await headings(page, "records")).toEqual(["Wochenbericht"]);
    await swap(page, "record");
    expect(await headings(page, "records")).toEqual(["Monatsbericht"]);
    await swap(page, "record");
    expect(await headings(page, "records")).toEqual(["Wochenbericht"]);
    await swap(page, "record");
    expect(await headings(page, "records")).toEqual(["Monatsbericht"]);
  });
});

test("a head that swaps its Bar, there and back in both directions, shows the page's name in the Bar that stands", async () => {
  await withPage(async (page) => {
    const shown = async () => ({
      headings: await headings(page, "bars"),
      bar: await page.locator("#bars [data-slot='head'] .k2-bar").evaluate((bar) => bar.textContent),
    });
    expect(await shown()).toEqual({ headings: ["Berichte"], bar: "BerichteNeu" });
    await swap(page, "bar");
    expect(await shown()).toEqual({ headings: ["Berichte"], bar: "BerichteTeilen" });
    await swap(page, "bar");
    expect(await shown()).toEqual({ headings: ["Berichte"], bar: "BerichteNeu" });
    await swap(page, "bar");
    expect(await shown()).toEqual({ headings: ["Berichte"], bar: "BerichteTeilen" });
  });
});

test("in a head with two bars at once, the first bar that stands shows the page's name, also after the first went and came back", async () => {
  await withPage(async (page) => {
    const shown = () => page.locator("#pair [data-slot='head'] .k2-bar").evaluateAll((bars) => bars.map((bar) => bar.textContent));
    expect(await shown()).toEqual(["LagerEinlagern", "Umlagern"]);
    await swap(page, "first");
    expect(await shown()).toEqual(["LagerUmlagern"]);
    await swap(page, "first");
    // as a reload would draw it: the name in the first bar
    expect(await shown()).toEqual(["LagerEinlagern", "Umlagern"]);
    expect(await headings(page, "pair")).toEqual(["Lager"]);
  });
});
