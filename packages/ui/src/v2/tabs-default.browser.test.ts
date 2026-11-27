import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";
import { demoBundle, openDemo, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-behavior/mount";

// W2 (Notebooks graph): the graph opens on its network on a wide screen and on its list on the phone, until the
// person picks a display. The server does not know the width, so the tabs mark both defaults (`defaultOn`) in its page
// and the stylesheet shows the one for the width: the first picture is already right, and nothing moves when the
// island runs. Then the default for the width is the current tab for assistive technology too.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup] = await Promise.all([demoBundle("tabs-default"), serverMarkup("tabs-default")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Each tab: its name, whether it draws the open tab's line, and whether it is current for assistive technology. */
const tabs = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2-tab")].map((tab) => {
      const style = getComputedStyle(tab);
      const box = tab.getBoundingClientRect();
      return {
        name: tab.textContent?.trim(),
        open: style.borderBottomColor !== "rgba(0, 0, 0, 0)" && style.borderBottomColor !== "transparent",
        current: tab.getAttribute("aria-current") === "page",
        box: [box.x, box.y, box.width, box.height].map(Math.round).join(","),
      };
    }),
  );
/** The server's page alone, before any script. */
const served = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style></head><body><div id="root">${markup}</div></body></html>`,
  );
  await settled(page);
  return page;
};

for (const [width, open] of [
  [390, "Liste"],
  [1440, "Netz"],
] as const)
  test(`${width} px: the default for the width is the open tab from the server's page on, and nothing moves when the island runs`, async () => {
    const before = await served(width);
    let first: Awaited<ReturnType<typeof tabs>>;
    try {
      first = await tabs(before);
      expect(first.filter((tab) => tab.open).map((tab) => tab.name)).toEqual([open]);
    } finally {
      await before.close();
    }
    const page = await openDemo(browser, bundle, css, { width, markup });
    try {
      const live = await tabs(page);
      // the same picture, and now the current tab for assistive technology
      expect(live.map(({ name, open, box }) => ({ name, open, box }))).toEqual(first.map(({ name, open, box }) => ({ name, open, box })));
      expect(live.filter((tab) => tab.current).map((tab) => tab.name)).toEqual([open]);
      // a tab the person picks is the open one, on every width
      await page.getByRole("button", { name: "Zeitleiste" }).click();
      await settled(page);
      const picked = await tabs(page);
      expect(picked.filter((tab) => tab.open).map((tab) => tab.name)).toEqual(["Zeitleiste"]);
      expect(picked.filter((tab) => tab.current).map((tab) => tab.name)).toEqual(["Zeitleiste"]);
    } finally {
      await page.close();
    }
  }, 30_000);
