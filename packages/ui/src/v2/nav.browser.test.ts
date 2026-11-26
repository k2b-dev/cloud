import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-nav.demo";

// A folding entry of the v2 sidebar ("› Mehr" with the archive, the bin and spam, mockup mail.html): a button that
// says whether it is open and which entries it controls, opened by the pointer and by Enter or Space, its entries one
// level further in. It starts open while it holds the open entry, also in the server's markup, and remembers nothing.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-nav"), serverMarkup("../v2-nav"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
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

const fold = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const names = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".k2-nav [data-k2-part='Nav.Item']")]
      .filter((item) => item.getClientRects().length > 0)
      .map((item) => item.textContent?.trim()),
  );

// The entries of a closed fold come hidden, so a Nav the server renders without an island folds open in place.
test("server markup: a closed fold sends its entries hidden; the fold that holds the open entry is open", () => {
  expect(markup).toMatch(/aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Mehr/);
  expect(markup).toMatch(/class="k2-nav-fold"[^>]*hidden[^>]*>(?:(?!<\/div>).)*Papierkorb/);
  expect(markup).toMatch(/aria-expanded="true"[^>]*>(?:(?!<\/button>).)*Rechnungen/);
  expect(markup).toContain("Bezahlt");
});

test("a fold opens and closes by the pointer and by Enter and Space; its entries stand one level further in", async () => {
  await withPage(async (page) => {
    const more = fold(page, "Mehr");
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await more.click();
    await page.getByRole("button", { name: "Papierkorb" }).waitFor();
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    // the fold names the group it opens, and the group is named by the fold
    const group = page.getByRole("group", { name: "Mehr" });
    expect(await group.getAttribute("id")).toBe(await more.getAttribute("aria-controls"));
    expect(await names(page)).toEqual([
      "Kontakt7",
      "Posteingang",
      "Gesendet",
      "Mehr",
      "Archiv",
      "Papierkorb",
      "Spam",
      "Lieferanten",
      "Rechnungen",
      "Offen",
      "Bezahlt",
    ]);
    await settled(page);
    const left = (name: string) =>
      page.evaluate((text) => {
        const item = [...document.querySelectorAll(".k2-ni")].find((each) => each.querySelector(".k2-ni-name")?.textContent === text)!;
        return Math.round(item.querySelector(".k2-icon")!.getBoundingClientRect().left);
      }, name);
    // a fold stands where its level stands; its entries 24 px further in
    expect(await left("Mehr")).toBe(await left("Gesendet"));
    expect((await left("Archiv")) - (await left("Mehr"))).toBe(24);
    expect((await left("Gesendet")) - (await left("Kontakt"))).toBe(24);
    // the keyboard: Enter closes, Space opens, the focus stays on the fold
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Papierkorb" }).waitFor({ state: "hidden" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Papierkorb" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Mehr");
  });
});

test("an entry inside a closed fold that becomes the open one shows itself", async () => {
  await withPage(async (page) => {
    expect(await fold(page, "Mehr").getAttribute("aria-expanded")).toBe("false");
    await page.evaluate(() => window.__openSpam?.());
    await page.getByRole("button", { name: "Spam" }).waitFor();
    expect(await page.getByRole("button", { name: "Spam" }).getAttribute("aria-current")).toBe("page");
    expect(await fold(page, "Mehr").getAttribute("aria-expanded")).toBe("true");
  });
});

const deeds = (page: Page) => page.evaluate(() => window.__navDeeds ?? []);
const closedMenu = (page: Page) => page.waitForFunction(() => !document.querySelector(".k2-menu"));

test("a group's '…' holds the group's deeds; a choice runs and closes the menu", async () => {
  await withPage(async (page) => {
    const more = page.getByRole("button", { name: "Postfächer verwalten" });
    expect(await more.getAttribute("aria-haspopup")).toBe("menu");
    await more.click();
    await page.locator(".k2-menu").waitFor();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Neues Postfach", "Gelöschte Postfächer"]);
    await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).click();
    await closedMenu(page);
    expect(await deeds(page)).toEqual(["deleted-mailboxes"]);
  });
});

test("an entry's '…' shows under the pointer and with the focus, over its count; Tab reaches it, nothing moves", async () => {
  await withPage(async (page) => {
    const entry = page.getByRole("button", { name: /^Kontakt/ });
    const more = page.getByRole("button", { name: "Aktionen für Kontakt" });
    // never a control inside a control
    expect(await page.locator(".k2-ni .k2-btn, .k2-ni button").count()).toBe(0);
    const look = () =>
      page.evaluate(() => {
        const row = document.querySelector(".k2-ni-row")!;
        const button = row.querySelector<HTMLElement>(":scope > .k2-btn")!;
        const count = row.querySelector(".k2-ni-count");
        const box = row.getBoundingClientRect();
        return {
          more: getComputedStyle(button).opacity,
          count: count ? getComputedStyle(count).display : "none",
          row: [Math.round(box.top), Math.round(box.height), Math.round(box.width)],
        };
      });
    await page.mouse.move(1000, 800);
    await settled(page);
    const resting = await look();
    expect(resting.more).toBe("0");
    expect(resting.count).not.toBe("none");
    await entry.hover();
    await settled(page);
    expect(await look()).toEqual({ ...resting, more: "1", count: "none" });
    // the keyboard: Tab from the entry reaches its "…", which shows; Enter opens its menu
    await page.mouse.move(1000, 800);
    await entry.focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Aktionen für Kontakt");
    await settled(page);
    expect((await look()).more).toBe("1");
    await page.keyboard.press("Enter");
    await page.locator(".k2-menu").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await closedMenu(page);
    expect(await deeds(page)).toEqual(["hide:kontakt"]);
    // the entry itself still opens
    await entry.click();
    expect(await deeds(page)).toEqual(["hide:kontakt", "open:kontakt"]);
    expect(await more.isVisible()).toBe(true);
  });
});

// The app builds its whole nav model again on every change (a new count of live mail). Entries keep their elements:
// an open fold stays open, the focus stays where it was, an open menu of an entry stays open.
test("a new model with a new count keeps an open fold open, the focus in place and an entry's menu open", async () => {
  await withPage(async (page) => {
    const more = fold(page, "Mehr");
    await more.click();
    await page.getByRole("button", { name: "Papierkorb" }).waitFor();
    await more.focus();
    await more.evaluate((element) => element.setAttribute("data-before", ""));
    await page.evaluate(() => window.__newMail?.());
    await page.waitForFunction(() => document.querySelector(".k2-ni-row .k2-ni-count")?.textContent === "8");
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-before"))).toBe(true);
    // an entry's menu stays open while the count behind it changes
    await page.getByRole("button", { name: "Aktionen für Kontakt" }).click();
    await page.locator(".k2-menu").waitFor();
    await page.evaluate(() => window.__newMail?.());
    await page.waitForFunction(() => document.querySelector(".k2-ni-row .k2-ni-count")?.textContent === "9");
    expect(await page.locator(".k2-menu").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Aktionen für Kontakt" }).getAttribute("aria-expanded")).toBe("true");
  });
});

test("after a click on the entry the '…' gives way again when the pointer leaves; the keyboard's focus shows it", async () => {
  await withPage(async (page) => {
    const look = () =>
      page.evaluate(() => {
        const row = document.querySelector(".k2-ni-row")!;
        return {
          more: getComputedStyle(row.querySelector(":scope > .k2-btn")!).opacity,
          count: getComputedStyle(row.querySelector(".k2-ni-count")!).display !== "none",
        };
      });
    await page.getByRole("button", { name: /^Kontakt/ }).click();
    await page.mouse.move(1000, 800);
    await settled(page);
    expect(await look()).toEqual({ more: "0", count: true });
    await page.keyboard.press("Tab");
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Aktionen für Kontakt");
    expect(await look()).toEqual({ more: "1", count: false });
  });
});

test("a closed fold that holds the open entry carries the open entry's tint", async () => {
  await withPage(async (page) => {
    const bills = fold(page, "Rechnungen");
    expect(await bills.getAttribute("aria-expanded")).toBe("true");
    expect(await bills.getAttribute("aria-controls")).toBeTruthy();
    const tint = () => bills.evaluate((element) => getComputedStyle(element).backgroundColor);
    const open = await tint();
    await bills.click();
    await page.getByRole("button", { name: "Bezahlt" }).waitFor({ state: "hidden" });
    await settled(page);
    // it still names the group it shows, which stays there hidden
    expect(await bills.getAttribute("aria-controls")).toBeTruthy();
    const current = await page.evaluate(() => {
      const probe = document.createElement("a");
      probe.className = "k2-ni";
      probe.setAttribute("aria-current", "page");
      document.querySelector(".k2-nav")!.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
    expect(await tint()).toBe(current);
    expect(await tint()).not.toBe(open);
  });
});
