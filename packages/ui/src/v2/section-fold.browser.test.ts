import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-section-fold.demo";
import { measureV2Layout } from "./testing";

// A section that folds (test/v2-section-fold.demo.tsx): the app holds `open`, the chevron at the end of the head says
// and changes it by pointer and key, the server and the first render show the same, and the section keeps the head,
// rhythm and lines of a section that cannot fold; folding moves only what stands below the folded content.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { height: 100%; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-section-fold"), serverMarkup("../v2-section-fold"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Opens the server markup; `mount` then lets the island render over it, as an @k2b/ssr page does. */
const withPage = async (width: number, run: (page: Page) => Promise<void>, { mount = true } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    if (mount) {
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each section: its fold button (what it says and controls), whether its content shows, and its geometry. */
const sections = () =>
  [...document.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].map((section) => {
    const head = section.querySelector<HTMLElement>(".k2-sh")!;
    const button = head.querySelector<HTMLElement>("[data-fold]");
    const controls = button?.getAttribute("aria-controls");
    const body = section.querySelector<HTMLElement>(":scope > .k2-sec-body");
    const rows = [...section.querySelectorAll<HTMLElement>(".k2-row")].filter((row) => row.checkVisibility());
    const top = section.getBoundingClientRect().top;
    const rel = (element: Element) => {
      const r = element.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top - top), Math.round(r.width), Math.round(r.height)];
    };
    return {
      title: section.getAttribute("aria-label"),
      fold: button && {
        expanded: button.getAttribute("aria-expanded"),
        // open, it names the content it shows; folded, the content is not made, so there is nothing to name
        controls: controls ? !!body && document.getElementById(controls) === body : body === null ? "nothing" : "body without a name",
        name: button.getAttribute("aria-label"),
        inHead: head.contains(button),
      },
      shows: rows.length,
      head: rel(head),
      rows: rows.map(rel),
      top: Math.round(top),
      height: Math.round(section.getBoundingClientRect().height),
      line: getComputedStyle(section).borderBottomWidth,
    };
  });

test("the server and the first render show the same sections: folded, open and not foldable", async () => {
  let server: ReturnType<typeof sections> = [];
  await withPage(
    1440,
    async (page) => {
      server = await page.evaluate(sections);
    },
    { mount: false },
  );
  await withPage(1440, async (page) => {
    const client = await page.evaluate(sections);
    expect(client).toEqual(server);
    expect(client.map((section) => [section.title, section.fold?.expanded ?? null, section.shows])).toEqual([
      ["Angeheftet", "true", 3],
      ["Archiviert", "false", 0],
      ["Alle", null, 3],
    ]);
    for (const section of client.filter((section) => section.fold))
      expect(section.fold).toEqual({
        ...section.fold!,
        controls: section.fold!.expanded === "true" ? true : "nothing",
        inHead: true,
        name: section.title,
      });
  });
});

for (const width of [1440, 390])
  test(`at ${width} px a section that can fold keeps the head, rhythm and line of any section`, async () => {
    await withPage(width, async (page) => {
      const [pinned, , all] = await page.evaluate(sections);
      // the same content, foldable or not: the same head, rows and height
      expect({ head: pinned!.head, rows: pinned!.rows, height: pinned!.height, line: pinned!.line }).toEqual({
        head: all!.head,
        rows: all!.rows,
        height: all!.height,
        line: all!.line,
      });
      expect((await measureV2Layout(page)).problems).toEqual([]);
      await page.getByRole("button", { name: "Angeheftet" }).click();
      await settled(page);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

test("the keyboard folds and opens a section; only what stands below the folded content moves", async () => {
  await withPage(1440, async (page) => {
    const before = await page.evaluate(sections);
    const toggle = page.getByRole("button", { name: "Angeheftet" });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await settled(page);
    const folded = await page.evaluate(sections);
    expect(await page.evaluate(() => window.__folds)).toEqual(["Angeheftet:false"]);
    expect(folded[0]!.fold?.expanded).toBe("false");
    expect(folded[0]!.shows).toBe(0);
    // the folded section keeps its place and head; the sections below move up by what its content took
    expect([folded[0]!.top, folded[0]!.head]).toEqual([before[0]!.top, before[0]!.head]);
    const took = before[0]!.height - folded[0]!.height;
    expect(took).toBeGreaterThan(0);
    for (const index of [1, 2]) expect(folded[index]!.top).toBe(before[index]!.top - took);
    await page.keyboard.press("Space");
    await settled(page);
    expect(await page.evaluate(() => window.__folds)).toEqual(["Angeheftet:false", "Angeheftet:true"]);
    expect(await page.evaluate(sections)).toEqual(before);
    // the folded one opens the same way
    await page.getByRole("button", { name: "Archiviert" }).focus();
    await page.keyboard.press("Enter");
    await settled(page);
    expect((await page.evaluate(sections))[1]!.shows).toBe(3);
  });
});
