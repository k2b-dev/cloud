import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-path.demo";

// A path keeps the page it names (Spaces, W3: "Space settin…" was cut before the long Space name). The places before
// it shorten first, each down to its own width or 12 characters; the page shortens last, with "…", and never runs past
// the path. From four places on, the middle ones stand in "…" with a menu, folded already on the server, until there is
// room for every place at that least. test/v2-path.demo.tsx at 390, 1024 and 1440 px, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const space = "Werkstatt Lindqvist-Oswald und Partner – Innenausbau, Möbelbau, Treppen, Fenster und Türen aus eigener Fertigung";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-path"), serverMarkup("../v2-path"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, sent = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${sent ? markup : ""}</div></body></html>`,
  );
  return page;
};
const live = async (page: Page) => {
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
};
const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await open(width);
  const errors = pageErrors(page);
  try {
    await live(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each path that shows: its page (whole or cut, inside the path), the places that show, "…", whether it runs over. */
const paths = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:12ch;font:var(--k2-t-body)";
    document.body.append(probe);
    const cap = probe.offsetWidth;
    probe.remove();
    return [...document.querySelectorAll<HTMLElement>("nav.k2-path")]
      .filter((nav) => nav.getClientRects().length > 0 && nav.getBoundingClientRect().width > 0)
      .map((nav) => {
        const room = nav.getBoundingClientRect();
        const shows = (element: Element) => getComputedStyle(element).visibility !== "hidden" && element.getBoundingClientRect().width > 0;
        const current = nav.querySelector<HTMLElement>('[aria-current="page"]')!;
        const box = current.getBoundingClientRect();
        const steps = [...nav.querySelectorAll<HTMLElement>(".k2-path-step")].filter(shows);
        return {
          name: nav.getAttribute("aria-label"),
          whole: current.scrollWidth <= current.clientWidth + 1,
          // the page never runs past the path, and a cut page ends in "…"
          inside: box.right <= room.right + 0.5 && box.left >= room.left - 0.5,
          ends: getComputedStyle(current).textOverflow,
          places: steps.map((step) => step.textContent),
          // a place that shows keeps at least its own width or 12 characters
          kept: steps.every((step) => step.getBoundingClientRect().width >= Math.min(step.scrollWidth, cap) - 1),
          more: [...nav.querySelectorAll("button")].filter(shows).map((button) => button.getAttribute("aria-label")),
          over: nav.scrollWidth > nav.clientWidth + 1,
        };
      });
  });

const named = async (page: Page) => Object.fromEntries((await paths(page)).map((path) => [path.name, path]));

for (const width of [390, 1024, 1440])
  test(`${width} px: every path keeps its page inside it, its places at their least, and runs over nothing`, async () => {
    await withPage(width, async (page) => {
      const found = await paths(page);
      // on the phone the head's path gives way to the phone bar of the shell, which names the page
      expect(found.map((path) => path.name)).toEqual([
        ...(width < 768 ? [] : ["Ort im Kopf"]),
        "Ort lang",
        "Ort tief",
        "Seite lang 3",
        "Seite lang 5",
        "Ort kurz",
      ]);
      for (const path of found)
        expect([path.name, path.inside, path.kept, path.over, path.ends]).toEqual([path.name, true, true, false, "ellipsis"]);
      const byName = await named(page);
      // a short deep path that has room shows every place and its page whole, without "…"
      expect(byName["Ort kurz"]).toMatchObject({ places: ["Spaces", "Werkstatt", "Projekte"], more: [], whole: true });
      // the long Space name gives way, and the settings stay whole
      expect(byName["Ort lang"]?.whole).toBe(true);
      // a page too long for the room is cut at its end, inside the path, after its places at their least (at 1440 px
      // WebKit's narrower type lets it stand whole)
      expect(byName["Seite lang 3"]).toMatchObject({ places: ["Spaces", space], ...(width <= 1024 ? { whole: false } : {}) });
      if (width < 768) {
        // no room for every place at its least: the middle ones are in "…"
        expect(byName["Ort tief"]).toMatchObject({ places: ["Spaces", "Küche Familie Oswald"], more: ["Weitere Orte"] });
      } else {
        // room for every place at its least: nothing folds (a wide pane shows "Projekte" too)
        expect(byName["Ort tief"]).toMatchObject({ places: ["Spaces", space, "Projekte", "Küche Familie Oswald"], more: [], whole: true });
        expect(byName["Ort im Kopf"]?.whole).toBe(true);
        const verwalten = page.getByRole("button", { name: "Verwalten" });
        expect(await verwalten.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
      }
      // a page too long even with every place at its least: its middle ones are in "…" (at 1440 px WebKit's narrower
      // type gives it room)
      if (width <= 1024)
        expect(byName["Seite lang 5"]).toMatchObject({ places: ["Spaces", "Küche Familie Oswald"], more: ["Weitere Orte"], whole: false });
    });
  });

for (const width of [390, 1024])
  test(`${width} px: the server sends a path of four places folded, and coming alive moves no page that stays folded`, async () => {
    const page = await open(width, true);
    const errors = pageErrors(page);
    try {
      await settled(page);
      const at = (name: string) =>
        page.evaluate(
          (label) => document.querySelector(`nav[aria-label="${label}"] [aria-current="page"]`)?.getBoundingClientRect().x ?? -1,
          name,
        );
      const sent = await at("Seite lang 5");
      expect(await page.evaluate(() => document.querySelectorAll('nav[aria-label="Seite lang 5"] .k2-path-step[data-folded]').length)).toBe(2);
      await live(page);
      expect(await at("Seite lang 5")).toBe(sent);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

test("a folded place is no stop of the Tab key: from the first place the next stop is '…', then the parent", async () => {
  await withPage(390, async (page) => {
    const nav = page.getByRole("navigation", { name: "Ort tief" });
    await nav.getByRole("link", { name: "Spaces" }).focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Weitere Orte");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Küche Familie Oswald");
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

test("places that get room come back; a focused place that folds hands its focus to '…'", async () => {
  await withPage(390, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    expect((await named(page))["Ort tief"]?.more).toEqual([]);
    await page.getByRole("navigation", { name: "Ort tief" }).getByRole("link", { name: "Projekte" }).focus();
    await page.setViewportSize({ width: 390, height: 900 });
    await settled(page);
    expect((await named(page))["Ort tief"]?.more).toEqual(["Weitere Orte"]);
    expect(
      await page.evaluate(() =>
        document.activeElement?.closest('nav[aria-label="Ort tief"]') ? document.activeElement.getAttribute("aria-label") : "elsewhere",
      ),
    ).toBe("Weitere Orte");
  });
});
