import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-path.demo";

// A path keeps the page it names whole (Spaces, W3: "Space settin…" was cut before the long Space name). The places
// before it shorten first, and the middle ones go into a "…" with a menu when even that is not enough; the actions
// beside a path in a head keep their words. test/v2-path.demo.tsx at 390 and 1024 px, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const space = "Werkstatt Lindqvist-Oswald und Partner – Innenausbau, Möbelbau, Treppen, Fenster und Türen aus eigener Fertigung";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-path"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each path that shows: the page it names (whole or cut), the places that show, whether it runs over its room. */
const paths = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("nav.k2-path")]
      .filter((nav) => nav.getClientRects().length > 0 && nav.getBoundingClientRect().width > 0)
      .map((nav) => {
        const room = nav.getBoundingClientRect();
        const shows = (element: Element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0;
        };
        const inside = (element: Element) => {
          const box = element.getBoundingClientRect();
          return box.left >= room.left - 0.5 && box.right <= room.right + 0.5 && box.right <= window.innerWidth + 0.5;
        };
        const current = nav.querySelector<HTMLElement>('[aria-current="page"]')!;
        const steps = [...nav.querySelectorAll<HTMLElement>(".k2-path-step")].filter(shows);
        return {
          name: nav.getAttribute("aria-label"),
          current: current.textContent,
          whole: current.scrollWidth <= current.clientWidth + 1 && inside(current),
          places: steps.map((step) => step.textContent),
          placesInside: steps.every(inside),
          more: [...nav.querySelectorAll("button")].filter(shows).map((button) => button.getAttribute("aria-label")),
          over: nav.scrollWidth > nav.clientWidth + 1,
        };
      }),
  );

for (const width of [390, 1024])
  test(`${width} px: every path keeps the page it names whole and stays in its room`, async () => {
    await withPage(width, async (page) => {
      const found = await paths(page);
      // on the phone the head's path gives way to the phone bar of the shell, which names the page
      expect(found.map((path) => path.name)).toEqual([...(width < 768 ? [] : ["Ort im Kopf"]), "Ort lang", "Ort tief", "Ort kurz"]);
      for (const path of found) expect([path.name, path.whole, path.placesInside, path.over]).toEqual([path.name, true, true, false]);
      const byName = Object.fromEntries(found.map((path) => [path.name, path]));
      // a short deep path that has room shows every place, without "…"
      expect(byName["Ort kurz"]).toMatchObject({ places: ["Spaces", "Werkstatt", "Projekte"], more: [] });
      // a deep path without room keeps its first place and the parent; the middle ones are in "…"
      expect(byName["Ort tief"]).toMatchObject({ places: ["Spaces", "Küche Familie Oswald"], more: ["Weitere Orte"] });
      if (width >= 768) {
        expect(byName["Ort im Kopf"]?.more).toEqual(["Weitere Orte"]);
        // the head's actions keep their words beside the path
        const verwalten = page.getByRole("button", { name: "Verwalten" });
        expect(await verwalten.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
      }
    });
  });

test("the '…' of a path opens a menu of the places it holds, as links in their order", async () => {
  await withPage(390, async (page) => {
    await page.getByRole("navigation", { name: "Ort tief" }).getByRole("button", { name: "Weitere Orte" }).click();
    await page.locator(".k2-menu").waitFor();
    await settled(page);
    const entries = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('.k2-menu a[role="menuitem"]')].map((link) => [
        link.textContent?.trim(),
        link.getAttribute("href"),
      ]),
    );
    expect(entries).toEqual([
      [space, "#space"],
      ["Projekte", "#projekte"],
    ]);
  });
});

test("a path whose places get room again shows them again, without '…'", async () => {
  await withPage(390, async (page) => {
    expect((await paths(page)).find((path) => path.name === "Ort tief")?.more).toEqual(["Weitere Orte"]);
    await page.setViewportSize({ width: 1800, height: 700 });
    await settled(page);
    expect((await paths(page)).find((path) => path.name === "Ort tief")).toMatchObject({
      places: ["Spaces", space, "Projekte", "Küche Familie Oswald"],
      more: [],
      whole: true,
    });
  });
});
