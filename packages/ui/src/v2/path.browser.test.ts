import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-path.demo";

// A path keeps the page it names (Spaces, W3: "Space settin…" was cut before the long Space name). The places before
// it shorten first, each down to its own width or 12 characters; the page shortens last, with "…", and never runs past
// the path. When not even that least has room, the places go into "…" with a menu (the middle ones first). The server
// sends every place, so a path with room never moves when the page comes alive. test/v2-path.demo.tsx at 390, 1024 and
// 1440 px, in Chromium and WebKit.

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
        "Ort mittel",
        "Ort kurz",
        "Ort und Aktionen",
        "Kurz und Aktionen",
      ]);
      for (const path of found)
        expect([path.name, path.inside, path.kept, path.over, path.ends]).toEqual([path.name, true, true, false, "ellipsis"]);
      const byName = await named(page);
      // a short deep path that has room shows every place and its page whole, without "…"
      expect(byName["Ort kurz"]).toMatchObject({ places: ["Spaces", "Werkstatt", "Projekte"], more: [], whole: true });
      // the long Space name gives way, and the settings stay whole
      expect(byName["Ort lang"]?.whole).toBe(true);
      // a page too long for the room is cut at its end, inside the path, after its places at their least (at 1440 px
      // WebKit's narrower type lets it stand whole; at 390 px not even the least of its places has room, so they fold)
      if (width === 1024) {
        expect(byName["Seite lang 3"]).toMatchObject({ places: ["Spaces", space], more: [], whole: false });
        expect(byName["Seite lang 5"]).toMatchObject({ more: [], whole: false });
      }
      if (width < 768) {
        // no room for every place at its least: the places fold into "…"; the first and the parent stay while they have room
        expect(byName["Ort tief"]?.more).toEqual(["Weitere Orte"]);
        expect(byName["Ort mittel"]).toMatchObject({ places: ["Spaces", "Küche"], more: ["Weitere Orte"], whole: true });
      } else {
        // room for every place at its least: nothing folds (it did with whole places, before)
        expect(byName["Ort tief"]).toMatchObject({ places: ["Spaces", space, "Projekte", "Küche Familie Oswald"], more: [], whole: true });
        expect(byName["Ort mittel"]?.more).toEqual([]);
        expect(byName["Ort im Kopf"]?.whole).toBe(true);
        const verwalten = page.getByRole("button", { name: "Verwalten" });
        expect(await verwalten.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
      }
    });
  });

for (const width of [1024, 1440])
  test(`${width} px: the server sends every place, and coming alive moves neither the page nor any place`, async () => {
    const page = await open(width, true);
    const errors = pageErrors(page);
    try {
      await settled(page);
      const at = () =>
        page.evaluate(() =>
          // also the head's path beside an end that fits: before the page is alive the bar stands as it does when
          // nothing folds (bar-fold.ts), the start given way to the room the end leaves
          ["Ort im Kopf", "Ort tief", "Ort mittel", "Seite lang 5"].map((name) =>
            [...document.querySelectorAll<HTMLElement>(`nav[aria-label="${name}"] > :is(.k2-path-step, b)`)].map((part) => {
              const box = part.getBoundingClientRect();
              return `${name} ${part.textContent?.slice(0, 12)} ${Math.round(box.x)} ${Math.round(box.width)}`;
            }),
          ),
        );
      const sent = await at();
      expect(await page.evaluate(() => document.querySelectorAll("nav.k2-path [data-folded]").length)).toBe(0);
      await live(page);
      expect(await at()).toEqual(sent);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

test("390 px: the one change coming alive may make is a path without room that folds, once", async () => {
  const page = await open(390, true);
  const errors = pageErrors(page);
  try {
    await settled(page);
    expect(await page.evaluate(() => document.querySelectorAll('nav[aria-label="Ort mittel"] [data-folded]').length)).toBe(0);
    await live(page);
    expect((await named(page))["Ort mittel"]).toMatchObject({ places: ["Spaces", "Küche"], more: ["Weitere Orte"] });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

// The fold of a bar (bar-fold.ts) owns the order beside a path: the end folds first, the path only after that.
const crowded = (page: Page) =>
  page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Ort und Aktionen"]')!;
    const bar = nav.closest<HTMLElement>(".k2-bar")!;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:var(--k2-start-least)";
    const current = nav.querySelector<HTMLElement>("b")!;
    current.append(probe);
    // the page's least: the start's least, or its own width where its name is shorter
    const least = Math.min(probe.offsetWidth, current.scrollWidth);
    probe.remove();
    // the end's own buttons, not the "…" the fold adds
    const foldable = [...bar.querySelectorAll<HTMLElement>(":scope > .k2-bar-end > .k2-btn[data-variant='ghost']")];
    const room = bar.getBoundingClientRect();
    const end = bar.querySelector<HTMLElement>(":scope > .k2-bar-end")!;
    return {
      fold: nav.getAttribute("data-fold"),
      endFolded: foldable.filter((button) => button.hasAttribute("data-k2-folded")).length,
      foldable: foldable.length,
      page: Math.round(current.getBoundingClientRect().width),
      least,
      inside: current.getBoundingClientRect().right <= nav.getBoundingClientRect().right + 0.5,
      endInside: end.getBoundingClientRect().right <= room.right + 4.5,
      primary: (() => {
        const primary = bar.querySelector<HTMLElement>(".k2-btn[data-variant='primary']")!;
        const box = primary.getBoundingClientRect();
        return box.width > 0 && box.right <= room.right + 4.5;
      })(),
    };
  });

for (const width of [390, 800, 1024])
  test(`${width} px: beside a crowded end the end folds first, and the page is never cut below its least`, async () => {
    await withPage(width, async (page) => {
      const found = await crowded(page);
      // the path folds only when every button that may fold is in the end's "…"
      if (found.fold !== "0") expect(found.endFolded).toBe(found.foldable);
      expect([found.inside, found.endInside, found.primary, found.page >= found.least - 1]).toEqual([true, true, true, true]);
    });
  });

test("1024 px: beside the crowded end nothing folds, and the paths stand as the server sent them, shortened or whole", async () => {
  const page = await open(1024, true);
  const errors = pageErrors(page);
  try {
    await settled(page);
    const at = () =>
      page.evaluate(() =>
        ["Ort und Aktionen", "Kurz und Aktionen"].flatMap((name) => {
          const bar = document.querySelector<HTMLElement>(`nav[aria-label="${name}"]`)!.closest<HTMLElement>(".k2-bar")!;
          return [...bar.querySelectorAll<HTMLElement>(".k2-path-step, b, .k2-bar-end > .k2-btn")].map((part) => {
            const box = part.getBoundingClientRect();
            return `${name} ${part.textContent?.slice(0, 10) || part.getAttribute("aria-label")} ${Math.round(box.x)} ${Math.round(box.width)}`;
          });
        }),
      );
    const sent = await at();
    await live(page);
    const deep = await crowded(page);
    expect([deep.fold, deep.endFolded]).toEqual(["0", 0]);
    expect((await named(page))["Ort und Aktionen"]?.whole).toBe(true);
    expect(await at()).toEqual(sent);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a folded place is no stop of the Tab key: from the first place the next stop is '…', then the parent", async () => {
  await withPage(390, async (page) => {
    const nav = page.getByRole("navigation", { name: "Ort mittel" });
    await nav.getByRole("link", { name: "Spaces" }).focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Weitere Orte");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Küche");
  });
});

test("the '…' of a path opens a menu of the places it holds, as links in their order", async () => {
  await withPage(390, async (page) => {
    await page.getByRole("navigation", { name: "Ort mittel" }).getByRole("button", { name: "Weitere Orte" }).click();
    await page.locator(".k2-menu").waitFor();
    await settled(page);
    const entries = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('.k2-menu a[role="menuitem"]')].map((link) => [
        link.textContent?.trim(),
        link.getAttribute("href"),
      ]),
    );
    expect(entries).toEqual([
      ["Werkstatt Nord", "#nord"],
      ["Projekte 2026", "#projekte"],
    ]);
  });
});

test("places that get room come back; a focused place that folds hands its focus to '…'", async () => {
  await withPage(390, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    expect((await named(page))["Ort mittel"]?.more).toEqual([]);
    await page.getByRole("navigation", { name: "Ort mittel" }).getByRole("link", { name: "Projekte 2026" }).focus();
    await page.setViewportSize({ width: 390, height: 900 });
    await settled(page);
    expect((await named(page))["Ort mittel"]?.more).toEqual(["Weitere Orte"]);
    expect(
      await page.evaluate(() =>
        document.activeElement?.closest('nav[aria-label="Ort mittel"]') ? document.activeElement.getAttribute("aria-label") : "elsewhere",
      ),
    ).toBe("Weitere Orte");
  });
});
