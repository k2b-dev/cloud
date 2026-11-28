import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-facts.client";

// Facts as the key-value detail: the label in a column of 116 px and 16 px
// to its value, pairs of 34 px in the main column and of 28 px in a side column, the label over its value on the
// phone. A kind makes the link and the copy button; a value that is not set is a quiet dash with a name. The fixture
// is test/v2-facts.client.tsx, with the worst case in the same list.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-facts.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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

/** Each pair of a list as boxes, rounded, with what its value holds. */
const pairs = (page: Page, list: number) =>
  page.evaluate((index) => {
    const dl = document.querySelectorAll(".k2-facts")[index]!;
    const round = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) };
    };
    return [...dl.querySelectorAll(".k2-fact-pair")].map((pair) => {
      const dt = pair.querySelector("dt")!;
      const dd = pair.querySelector("dd")!;
      const value = dd.querySelector(".k2-fact-value")!;
      return {
        label: dt.textContent,
        dt: round(dt),
        dd: round(dd),
        links: [...dd.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        copy: dd.querySelectorAll(".k2-btn").length,
        empty: dd.querySelector(".k2-fact-empty > .k2-hidden-text")?.textContent ?? null,
        overflows: value.scrollWidth > value.clientWidth + 1,
      };
    });
  }, list);

test("1440 px: the label column is 116 px and 16 px to the value, pairs of 34 px; a side column is dense", async () => {
  await withPage(1440, async (page) => {
    const main = await pairs(page, 0);
    const email = main[0]!;
    expect(email.dd.left - email.dt.left).toBe(132);
    expect(email.dd.bottom - email.dd.top).toBe(34);
    // the long label wraps in its column and the value stays on the label's first line
    const long = main.find((pair) => pair.label?.startsWith("Abweichende"))!;
    expect(long.dt.right - long.dt.left).toBe(132);
    expect(long.dd.top).toBe(long.dt.top);
    const side = await pairs(page, 1);
    expect(side[0]!.dd.left - side[0]!.dt.left).toBe(108);
    expect(side[0]!.dd.bottom - side[0]!.dd.top).toBe(28);
    // nothing runs out of its value, also the address that cannot break
    expect([...main, ...side].filter((pair) => pair.overflows).map((pair) => pair.label)).toEqual([]);
  });
});

test("a kind makes the link and the copy button; a scheme that may not open stays words; nothing set is a named dash", async () => {
  await withPage(1440, async (page) => {
    const byLabel = Object.fromEntries((await pairs(page, 0)).map((pair) => [pair.label, pair]));
    expect(byLabel["E-Mail"]).toMatchObject({ links: ["mailto:o.brandner@example.org"], copy: 1 });
    // two numbers: each its own link, and no copy button that could copy only one
    expect(byLabel.Telefon).toMatchObject({ links: ["tel:+49305550142", "tel:+49305550990"], copy: 0 });
    expect(byLabel.Anschrift).toMatchObject({ links: [], copy: 1 });
    expect(byLabel.Website!.links).toEqual(["https://www.beispiel-verwaltung.example.org/kunden/portal/rechnungen?jahr=2026"]);
    // a scheme that may not open, and an address with a query that would add to the mail, stay words without a link
    expect(byLabel.Skript!.links).toEqual([]);
    expect(byLabel.Kopie).toMatchObject({ links: [], copy: 1 });
    // a port is no scheme; the trunk zero "(0)" leaves an international number
    expect(byLabel.Port!.links).toEqual(["https://example.org:8080/status"]);
    expect(byLabel.Zentrale!.links).toEqual(["tel:+49301234567"]);
    expect(byLabel["Steuer-ID"]).toMatchObject({ empty: "nicht angegeben", copy: 0 });
    expect(byLabel.Fax).toMatchObject({ empty: "nicht angegeben", links: [], copy: 0 });
    // the web address stands on one line without its scheme, cut with "…", its whole address as its hint
    const url = await page.evaluate(() => {
      const entry = document.querySelector<HTMLElement>(".k2-fact-entry[data-url]")!;
      return { height: entry.getBoundingClientRect().height, text: entry.textContent, title: entry.querySelector("a")!.title };
    });
    expect(url.height).toBe(20);
    expect(url.text?.startsWith("www.beispiel-verwaltung")).toBe(true);
    expect(url.title.startsWith("https://")).toBe(true);
  });
});

test("390 px: every label stands over its value", async () => {
  await withPage(390, async (page) => {
    for (const list of [0, 1])
      for (const pair of await pairs(page, list)) {
        expect(pair.dd.top).toBeGreaterThanOrEqual(pair.dt.bottom);
        expect(pair.dd.left).toBe(pair.dt.left);
        expect(pair.overflows).toBe(false);
      }
  });
});
