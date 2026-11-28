import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menu-choice.demo";
import type {} from "../../test/v2-menu-choice-lost.demo";
import type {} from "../../test/v2-menus.demo";

// A choice in a menu always arrives (#4361: in the Assistant's "Alle Chats" in WebKit the click on "Archiviert" landed
// and the choice never did). Core calls a radio group's own handler only while it holds the group's props; without
// them the value stays in core's memory. The menu now hears every choice as a whole. Tested: a group whose props are
// missing at the moment of choice (made on purpose, test/v2-menu-choice-lost.demo.tsx), and as guards, a choice made
// at once after the menu opens, 50 times, in the menus demo and in a dialog beside a reloading search
// (test/v2-menu-choice.demo.tsx), in Chromium and WebKit. Every round is logged.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";
const rounds = 50;

let browser: Browser;
let bundle: string;
let dialogBundle: string;
let lostBundle: string;
beforeAll(async () => {
  [bundle, dialogBundle, lostBundle, browser] = await Promise.all([
    demoBundle("../v2-menus"),
    demoBundle("../v2-menu-choice"),
    demoBundle("../v2-menu-choice-lost"),
    launchBrowser(),
  ]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, demo?: string) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: demo ?? bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);

test("a group whose props are missing at the moment of choice: the choice still arrives, and the menu closes", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Ansicht" }).click();
    await page.getByRole("menuitemradio", { name: "Archiviert" }).click();
    await page.locator(".k2-menu").waitFor({ state: "detached" });
    await page.waitForFunction(() => (window.__lostChoices?.length ?? 0) > 0, undefined, { timeout: 2000 }).catch(() => undefined);
    expect(await page.evaluate(() => window.__lostChoices ?? [])).toEqual(["archived"]);
  }, lostBundle);
});

test(`a choice made at once after the menu opens arrives, ${rounds} times`, async () => {
  await withPage(async (page) => {
    const kinds = ["all", "forward", "reply"] as const;
    const names = { reply: "Antworten", all: "Allen antworten", forward: "Weiterleiten" };
    const lost: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const want = kinds[round % kinds.length]!;
      const before = (await deeds(page)).length;
      await page.getByRole("button", { name: "Antwort" }).click();
      // as the Assistant's test does: read the chosen entry, then choose another one at once
      await page.getByRole("menuitemradio", { name: "Antworten", exact: true }).getAttribute("aria-checked");
      await page.getByRole("menuitemradio", { name: names[want], exact: true }).click();
      const arrived = await page
        .waitForFunction((count) => (window.__deeds?.length ?? 0) > count, before, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      const last = (await deeds(page)).at(-1);
      console.log(`round ${round}: want kind:${want}, arrived ${arrived}, last ${last}`);
      if (!arrived || last !== `kind:${want}`) lost.push(`round ${round}: kind:${want} (last ${last})`);
      // whatever happened, the menu is closed before the next round
      if (await page.locator(".k2-menu").count()) await page.keyboard.press("Escape");
      await page.locator(".k2-menu").waitFor({ state: "detached" });
    }
    expect(lost).toEqual([]);
  });
}, 120_000);

// The Assistant's steps (#4361): the search is filled and emptied, the filter opens, its chosen entry is read, and
// "Archiviert" is chosen at once, while the search's reload (180 ms after the last keystroke) is due.
test(`in a dialog beside a search that reloads, a choice made at once after the menu opens arrives, ${rounds} times`, async () => {
  await withPage(async (page) => {
    const dialog = page.getByRole("dialog", { name: "Alle Chats" });
    const lost: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const [want, back] = round % 2 === 0 ? ["Archiviert", "Alle Chats"] : ["Alle Chats", "Archiviert"];
      const before = (await page.evaluate(() => window.__choices ?? [])).length;
      await dialog.getByRole("searchbox").fill("Rechnung");
      await dialog.getByRole("searchbox").fill("");
      await dialog.getByRole("button", { name: back, exact: true }).click();
      await page.getByRole("menuitemradio", { name: back, exact: true }).getAttribute("aria-checked");
      await page.getByRole("menuitemradio", { name: want, exact: true }).click();
      const named = await dialog
        .getByRole("button", { name: want, exact: true })
        .waitFor({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      const choices = await page.evaluate(() => window.__choices ?? []);
      console.log(
        `dialog round ${round}: want ${want}, named ${named}, choices +${choices.length - before}, menu open ${await page.locator(".k2-menu").count()}`,
      );
      if (!named) lost.push(`round ${round}: ${want}`);
      if (await page.locator(".k2-menu").count()) await page.keyboard.press("Escape");
      await page.locator(".k2-menu").waitFor({ state: "detached" });
      // the search's reload is over before the next round
      await page.waitForTimeout(400);
    }
    expect(lost).toEqual([]);
  }, dialogBundle);
}, 180_000);
