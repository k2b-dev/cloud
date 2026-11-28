import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-nav-switcher.demo";
import { measureV2Layout } from "./testing";

// The switcher at the top of a sidebar (`Nav` `switcher`): the open base on a button; behind it the bases in their
// groups ("Zuletzt geöffnet", "Alle Basen"), a search from 8 of them, and the deeds. Arrow keys move from the search
// into the list, Escape closes and gives the focus back, a deed closes the panel; on the phone the shell's menu shows it.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-nav-switcher"), serverMarkup("../v2-nav-switcher"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const phone = width < 768;
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
};

/** The words of the open panel's entries, its headings and whether its search shows. */
const panel = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".k2-switcher");
    return {
      open: !!element,
      presentation: element?.dataset.presentation,
      search: !!element?.querySelector("input[type=search]"),
      headings: [...(element?.querySelectorAll(".k2-mh") ?? [])].map((heading) => heading.textContent),
      entries: [...(element?.querySelectorAll(".k2-mi") ?? [])].map((entry) => entry.querySelector(".k2-mi-label")?.textContent),
    };
  });

// the button is called what it shows (WCAG 2.5.3: the visible words are its name); what it does is its description
const button = (page: Page) => page.getByRole("button", { name: "Werkstatt", exact: true });
const description = (page: Page) =>
  button(page).evaluate((element) =>
    (element.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName);

test("server markup: the open base names the switcher's button before the island, its purpose describes it", () => {
  expect(markup).toContain('data-k2-part="NavSwitcher"');
  expect(markup).toContain("aria-describedby=");
  expect(markup).not.toContain('aria-label="Base wechseln"');
  expect(markup).toContain("Werkstatt");
  expect(markup).not.toContain("k2-switcher");
});

test("the panel holds the bases in their groups, the search from 8, and the deeds after a line", async () => {
  await withPage(1440, async (page) => {
    // the closed switcher keeps the v2 rules (an open panel lies over the sidebar's grip on purpose)
    expect((await measureV2Layout(page)).problems).toEqual([]);
    // the open base's sign stands at its own size on the button (24 px, as the taste study draws it), not as an entry's
    expect(
      await button(page)
        .locator(".k2-mk")
        .evaluate((mark) => mark.getBoundingClientRect().width),
    ).toBe(24);
    expect(await description(page)).toBe("Base wechseln");
    await button(page).click();
    await page.locator(".k2-switcher").waitFor();
    // with a search the first focus stands in it, as in the shell's switcher
    await page.waitForFunction(() => document.activeElement?.getAttribute("type") === "search");
    const shown = await panel(page);
    expect(shown.search).toBe(true);
    expect(shown.headings).toEqual(["Zuletzt geöffnet", "Alle Basen"]);
    expect(shown.entries.slice(0, 5)).toEqual(["Werkstatt", "Lager Nord", "Kunden", "Personal", "Fuhrpark"]);
    expect(shown.entries.slice(-2)).toEqual(["Neue Base", "Aus Vorlage"]);
    expect(shown.entries).toHaveLength(14);
    // the panel is as high as what it holds: a class of another part (the toggle's `.k2-switch`) once pressed it to 20 px
    const size = await page.locator(".k2-switcher").evaluate((element) => ({ box: element.clientHeight, content: element.scrollHeight }));
    expect(size.box).toBe(size.content);
    // the open base carries its tick and says it is the page
    expect(await page.locator('.k2-switcher .k2-mi[aria-current="page"] .k2-mi-label').textContent()).toBe("Werkstatt");
  });
});

test("the search narrows both groups; nothing found says so; arrows go from the search into the list", async () => {
  await withPage(1440, async (page) => {
    await button(page).click();
    const search = page.getByRole("searchbox", { name: "Base suchen" });
    await search.fill("aus");
    let shown = await panel(page);
    expect(shown.entries).toEqual(["Ausleihen", "Neue Base", "Aus Vorlage"]);
    expect(shown.headings).toEqual(["Alle Basen"]);
    await search.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Ausleihen");
    await page.keyboard.press("ArrowUp");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("type"))).toBe("search");
    await search.fill("zzz");
    shown = await panel(page);
    // the quiet line is a status in a slot of its own: a screen reader hears it, and it stands where it stood
    const status = page.locator('.k2-switcher-none[role="status"]');
    expect(await status.textContent()).toBe("Keine Base passt");
    expect(shown.entries).toEqual(["Neue Base", "Aus Vorlage"]);
    await search.fill("");
    expect(await status.count()).toBe(1);
    expect(await status.textContent()).toBe("");
  });
});

test("Home and End go to the ends; Enter in the search opens the first match; the open base only closes", async () => {
  await withPage(1440, async (page) => {
    await button(page).click();
    const search = page.getByRole("searchbox", { name: "Base suchen" });
    await search.press("ArrowDown");
    await page.keyboard.press("End");
    expect(await focused(page)).toContain("Aus Vorlage");
    await page.keyboard.press("Home");
    expect(await focused(page)).toContain("Werkstatt");
    // the first match of "werk" is the open base: choosing it closes the panel and the page stays
    await search.fill("werk");
    const before = page.url();
    await search.press("Enter");
    await page.locator(".k2-switcher").waitFor({ state: "detached" });
    expect(page.url()).toBe(before);
  });
});

test("without a search the first focus stands on the open base", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => window.__switcherFew?.());
    await button(page).click();
    await page.locator(".k2-switcher").waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-current") === "page");
    expect(await focused(page)).toContain("Werkstatt");
  });
});

test("Escape closes the panel and gives the focus back; a deed runs and closes it", async () => {
  await withPage(1440, async (page) => {
    await button(page).click();
    await page.locator(".k2-switcher").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".k2-switcher").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-k2-part"))).toBe("NavSwitcher");
    await button(page).click();
    await page.locator(".k2-switcher").getByText("Aus Vorlage").click();
    await page.locator(".k2-switcher").waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.__switcherDid)).toBe("template");
  });
});

test("500 bases: the panel lists 20 and says how many the search reaches; a search lists at most 50 matches", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => window.__switcherMany?.());
    await button(page).click();
    await page.locator(".k2-switcher").waitFor();
    // 20 bases and the two deeds
    expect((await panel(page)).entries).toHaveLength(22);
    expect(await page.locator(".k2-switcher-none").textContent()).toBe("+480 weitere über die Suche");
    await page.getByRole("searchbox", { name: "Base suchen" }).fill("base 4");
    // "Base 4", "Base 40" … "Base 49" and "Base 400" … "Base 495": 107 matches, 50 listed
    expect((await panel(page)).entries).toHaveLength(52);
    expect(await page.locator(".k2-switcher-none").textContent()).toBe("57 weitere Treffer – genauer suchen");
  });
});

test("with fewer than 8 bases there is no search", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => window.__switcherFew?.());
    await button(page).click();
    await page.locator(".k2-switcher").waitFor();
    const shown = await panel(page);
    expect(shown.search).toBe(false);
    expect(shown.entries).toEqual(["Werkstatt", "Lager Nord", "Kunden", "Neue Base", "Aus Vorlage"]);
  });
});

test("on the phone the sidebar leaves with its switcher: the shell's menu shows it (V2WorkspaceNavigation)", async () => {
  await withPage(390, async (page) => {
    expect(await button(page).isVisible()).toBe(false);
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
});
