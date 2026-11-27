import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";

// A menu entry with a data colour shows it as a dot before its words (Notebooks graph, W2: the area filter). The colour
// goes through the colour guard, so what is no colour never reaches the page; the dot is decoration, so an entry's
// name stays its words; and every entry keeps the same place for its words. test/v2-menu-dot.demo.tsx at 1440 and
// 390 px, light and dark, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-menu-dot"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withMenu = async (width: number, dark: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: dark ? "dark" : "light" });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${dark ? ' class="dark"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await page.getByRole("button", { name: "Bereich" }).click();
    await page.locator(".k2-menu").waitFor();
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each entry: its name, the colour of its dot (none without one), and where its words start. */
const entries = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.k2-menu [role="menuitemradio"]')].map((entry) => {
      const dot = entry.querySelector<HTMLElement>(".k2-mi-dot");
      const box = dot?.getBoundingClientRect();
      return {
        name: entry.getAttribute("aria-label") ?? entry.textContent?.trim(),
        dot: dot ? getComputedStyle(dot).backgroundColor : null,
        hidden: dot ? dot.getAttribute("aria-hidden") : null,
        size: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : null,
        words: Math.round(entry.querySelector(".k2-mi-label")!.getBoundingClientRect().left),
        style: entry.innerHTML.includes("background:url") || entry.innerHTML.includes("example.invalid"),
      };
    }),
  );

for (const width of [1440, 390])
  for (const dark of [false, true])
    test(`${width} px ${dark ? "dark" : "light"}: a coloured entry shows its dot, the name stays its words, the words line up`, async () => {
      await withMenu(width, dark, async (page) => {
        const found = await entries(page);
        const neutral = await page.evaluate(() => {
          const probe = document.createElement("i");
          probe.style.color = "var(--k2-n300)";
          document.body.append(probe);
          const colour = getComputedStyle(probe).color;
          probe.remove();
          return colour;
        });
        expect(found.map(({ name, dot, hidden, size }) => ({ name, dot, hidden, size }))).toEqual([
          { name: "Werkstatt", dot: "rgb(15, 118, 110)", hidden: "true", size: "8x8" },
          { name: "Büro", dot: "rgb(124, 58, 237)", hidden: "true", size: "8x8" },
          // without a colour: no dot, the words in the same place
          { name: "Lager", dot: null, hidden: null, size: null },
          // what is no colour never reaches the page: a neutral dot
          { name: "Fremd", dot: neutral, hidden: "true", size: "8x8" },
        ]);
        expect(found.some((entry) => entry.style)).toBe(false);
        expect(new Set(found.map((entry) => entry.words)).size).toBe(1);
        // the accessible name of an entry is its words, the dot adds nothing
        expect(await page.getByRole("menuitemradio", { name: "Werkstatt", exact: true }).count()).toBe(1);
      });
    });

test("forced colours: the dot stays drawn, in the system's text colour", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  try {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await page.getByRole("button", { name: "Bereich" }).click();
    await page.locator(".k2-menu").waitFor();
    await settled(page);
    const found = await page.evaluate(() => {
      const dot = document.querySelector<HTMLElement>(".k2-menu .k2-mi-dot");
      const probe = document.createElement("i");
      probe.style.color = "CanvasText";
      document.body.append(probe);
      const text = getComputedStyle(probe).color;
      probe.remove();
      return { dot: dot ? getComputedStyle(dot).backgroundColor : null, text };
    });
    expect(found.dot).toBe(found.text);
  } finally {
    await page.close();
  }
});
