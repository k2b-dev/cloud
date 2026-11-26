import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-filter-verbs.demo";

// Verbs of the v2 FilterBar in a real engine with v2.css, on an inventory of thirteen fields in categories: a
// statement says its verb ("Titel enthält Vitrine", "Status ist weder … noch …", "Preis über 500 €", "Fällig ist
// leer"), the editor offers the verbs and what each compares with, "+ Filter" searches the fields, and the query names
// its own parameters, so the page keeps `sort` and `q`. The page has a real address, because the bar writes the history.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://verbs.test";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-filter-verbs"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (search: string, run: (page: Page) => Promise<void>, { width = 1440, touch = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    }),
  );
  try {
    await page.goto(`${origin}/inventar${search ? `?${search}` : ""}`);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const statements = (page: Page) => page.locator(".k2-fbar-flow .k2-stmt-b").allTextContents();
const address = (page: Page) => decodeURIComponent(new URL(page.url()).search.slice(1));
/** The titles of the rows the table shows, in order. */
const rows = (page: Page) => page.locator("tbody tr:not([data-group]):not([data-loading]) td:nth-child(2)").allTextContents();

/** Waits until the sheet keeps its place for two frames inside the window, once it has slid up. */
const steady = (page: Page) =>
  page.waitForFunction(
    () => {
      const element = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const last = Number(element.dataset.testTop ?? "NaN");
      element.dataset.testTop = String(box.top);
      return box.top === last && box.bottom <= innerHeight + 1;
    },
    undefined,
    { polling: 100, timeout: 5000 },
  );

/** Opens the editor of a statement by its field. */
const edit = async (page: Page, field: string) => {
  await page.getByRole("button", { name: new RegExp(`^Filter ${field}\\b.* bearbeiten$`) }).click();
  await page.locator(".k2-fpop").waitFor();
};
/** Chooses a verb in the open editor's "Vergleich". */
const chooseVerb = async (page: Page, verb: string) => {
  await page.locator(".k2-fpop .k2-fed-verb [data-select]").click();
  await page.getByRole("option", { name: verb, exact: true }).click();
  await page.locator(".k2-menu[data-listbox]").waitFor({ state: "hidden" });
};

test("a statement says its verb: contains, is none of, above, is empty; a field without verbs keeps its sentence", async () => {
  await withPage("title=Vitrine&status.not=online,sold&price.after=500&due.empty=&shelf=B", async (page) => {
    expect(await statements(page)).toEqual([
      "Status ist weder Online noch Verkauft",
      "Titel enthält Vitrine",
      "Preis über 500 €",
      "Fällig ist leer",
      "Regal ist B",
    ]);
    expect(await page.getByRole("button", { name: "Filter Titel enthält Vitrine bearbeiten" }).count()).toBe(1);
  });
  await withPage("status.not=sold&era.notEmpty=&price.before=500&received.is=2026-10-20", async (page) => {
    expect(await statements(page)).toEqual([
      "Status ist nicht Verkauft",
      "Preis unter 500 €",
      "Eingang am 20.10.2026",
      "Epoche ist nicht leer",
    ]);
  });
});

test("the editor offers the field's verbs; another verb of the same kind keeps the value, “ist leer” applies at once", async () => {
  await withPage("title=Vitrine", async (page) => {
    await edit(page, "Titel");
    const select = page.locator(".k2-fpop .k2-fed-verb [data-select]");
    expect(await select.textContent()).toBe("enthält");
    await select.click();
    expect(await page.locator(".k2-menu[data-listbox]").getByRole("option").allTextContents()).toEqual([
      "enthält",
      "ist",
      "enthält nicht",
      "beginnt mit",
      "ist leer",
      "ist nicht leer",
    ]);
    await page.getByRole("option", { name: "beginnt mit", exact: true }).click();
    await page.locator(".k2-menu[data-listbox]").waitFor({ state: "hidden" });
    // the editor stays open, the value stays, the verb goes into the address
    expect(await page.locator(".k2-fpop").count()).toBe(1);
    expect(address(page)).toBe("title.startsWith=Vitrine");
    expect(await statements(page)).toEqual(["Titel beginnt mit Vitrine"]);
    expect(await page.locator(".k2-fpop .k2-fed-field input").inputValue()).toBe("Vitrine");
    await chooseVerb(page, "ist leer");
    expect(address(page)).toBe("title.empty=");
    expect(await statements(page)).toEqual(["Titel ist leer"]);
    // nothing to type for "ist leer"
    expect(await page.locator(".k2-fpop .k2-fed-field").count()).toBe(0);
    // back to "enthält": there is no value to keep, so the filter waits as a dashed draft in its open editor
    await chooseVerb(page, "enthält");
    expect(address(page)).toBe("");
    expect(await page.locator(".k2-stmt[data-draft]").count()).toBe(1);
    await page.locator(".k2-fpop .k2-fed-field input").fill("Spiegel");
    await page.keyboard.press("Enter");
    expect(address(page)).toBe("title=Spiegel");
    expect(await rows(page)).toEqual(["Spiegel mit Goldrahmen"]);
  });
});

test("a number verb takes one number in the locale; “zwischen” goes back to the range and its presets", async () => {
  await withPage("price.after=500", async (page) => {
    await edit(page, "Preis");
    const field = page.locator(".k2-fpop .k2-nentry input");
    expect(await field.inputValue()).toBe("500");
    // the number keeps its value when the verb changes to another number verb
    await chooseVerb(page, "unter");
    expect(address(page)).toBe("price.before=500");
    await field.fill("1.750");
    await page.keyboard.press("Enter");
    expect(address(page)).toBe("price.before=1750");
    expect(await statements(page)).toEqual(["Preis unter 1.750 €"]);
    expect(await rows(page)).toEqual([
      "Jugendstil-Vitrine",
      "Vitrinenschrank, Nussbaum",
      "Sammeltasse mit Untertasse",
      "Tischlampe, Messing",
    ]);
    // a range is another kind of value: the filter waits for one, the presets show
    await chooseVerb(page, "zwischen");
    expect(address(page)).toBe("");
    await page.locator(".k2-fpop").getByRole("option", { name: "500 € bis 2.000 €" }).click();
    expect(address(page)).toBe("price=500..2000");
    expect(await statements(page)).toEqual(["Preis 500 € bis 2.000 €"]);
  });
});

test("a day verb picks one day in the calendar of the editor; “ist leer” finds the rows without one", async () => {
  await withPage("due=2026-12-15", async (page) => {
    expect(await statements(page)).toEqual(["Fällig vor 15.12.2026"]);
    expect(await rows(page)).toEqual(["Spiegel mit Goldrahmen"]);
    await edit(page, "Fällig");
    const calendar = page.locator(".k2-fpop .k2-fed-pick");
    await calendar.locator('[data-value="2027-01-01"]').click();
    expect(address(page)).toBe("due=2027-01-01");
    expect(await rows(page)).toEqual(["Jugendstil-Vitrine", "Spiegel mit Goldrahmen"]);
    await chooseVerb(page, "nach");
    // the first verb ("vor") keeps the plain name; a day stays a day for "nach"
    expect(address(page)).toBe("due.after=2027-01-01");
    expect(await rows(page)).toEqual(["Tischlampe, Messing"]);
    await chooseVerb(page, "ist leer");
    expect(address(page)).toBe("due.empty=");
    expect(await rows(page)).toEqual(["Vitrinenschrank, Nussbaum", "Kaminuhr, Bronze vergoldet", "Sammeltasse mit Untertasse"]);
  });
});

test("a choice says “ist nicht” and “ist weder … noch …”; back and forward bring the verb back", async () => {
  await withPage("", async (page) => {
    await page.locator(".k2-fbar-add .k2-btn").click();
    await page.locator(".k2-fpick input").fill("status");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.locator(".k2-fpop .k2-fed").waitFor();
    await chooseVerb(page, "ist nicht");
    await page.locator(".k2-fpop").getByRole("option", { name: "Verkauft" }).click();
    expect(address(page)).toBe("status.not=sold");
    await page.locator(".k2-fpop").getByRole("option", { name: "Online" }).click();
    expect(address(page)).toBe("status.not=online,sold");
    expect(await statements(page)).toEqual(["Status ist weder Online noch Verkauft"]);
    await page.keyboard.press("Escape");
    await page.locator(".k2-fpop").waitFor({ state: "detached" });
    // one history entry for the editor session: back is the list before it
    await page.goBack();
    await page.waitForFunction(() => location.search === "");
    expect(await statements(page)).toEqual([]);
    await page.goForward();
    await page.waitForFunction(() => location.search !== "");
    expect(await statements(page)).toEqual(["Status ist weder Online noch Verkauft"]);
    await edit(page, "Status");
    expect(await page.locator(".k2-fpop .k2-fed-verb [data-select]").textContent()).toBe("ist nicht");
  });
});

test("“+ Filter” with many fields searches them: groups by category, accents do not matter, nothing found says so", async () => {
  await withPage("price.after=500", async (page) => {
    await page.locator(".k2-fbar-add .k2-btn").click();
    const picker = page.locator(".k2-fpick");
    await picker.waitFor();
    // the focus is in the search
    await page.waitForFunction(() => document.activeElement?.matches(".k2-fpick input") === true);
    expect(await picker.locator(".k2-opt-head").allTextContents()).toEqual(["Häufig", "Preise", "Termine", "Herkunft", "Lager"]);
    // an active field shows its value
    expect(
      await picker
        .getByRole("option", { name: /^Preis/ })
        .first()
        .textContent(),
    ).toBe("Preisüber 500 €");
    const input = picker.locator("input");
    await input.fill("termine");
    expect(await picker.getByRole("option").allTextContents()).toEqual(["Eingang", "Fällig", "Zuletzt gesehen"]);
    await input.fill("fallig");
    expect(await picker.getByRole("option").allTextContents()).toEqual(["Fällig"]);
    await input.fill("xyz");
    expect(await picker.getByRole("option").count()).toBe(0);
    expect(await picker.textContent()).toContain("Kein Filter passt zu „xyz“.");
    // Enter opens the field the arrows reach
    await input.fill("herkunfts");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await picker.waitFor({ state: "detached" });
    await page.locator(".k2-fpop .k2-fed").waitFor();
    expect(await page.locator(".k2-fpop .k2-fed-t").textContent()).toBe("Herkunftsort");
    expect(await page.locator(".k2-stmt[data-draft] .k2-stmt-b").textContent()).toBe("Herkunftsort …");
    await page.waitForFunction(() => document.activeElement?.matches(".k2-fpop .k2-fed-field input") === true);
    await page.keyboard.type("Wien");
    await page.keyboard.press("Enter");
    expect(address(page)).toBe("price.after=500&origin=Wien");
    expect(await rows(page)).toEqual(["Jugendstil-Vitrine"]);
  });
});

test("the query's own parameter names: sort and grouping write `ordnung` and `gruppe`; the page's `sort` and `q` stay", async () => {
  await withPage("sort=col3.asc&q=raw&suche=Vitrine", async (page) => {
    expect(await page.locator(".k2-order .k2-btn").first().textContent()).toBe("Eingang · Neueste zuerst");
    await page.locator(".k2-order .k2-btn").first().click();
    await page.getByRole("menuitemradio", { name: "Preis" }).click();
    expect(address(page)).toBe("sort=col3.asc&q=raw&suche=Vitrine&ordnung=price.desc");
    await page.locator(".k2-order .k2-btn").nth(1).click();
    await page.getByRole("menuitemradio", { name: "Status" }).click();
    expect(address(page)).toBe("sort=col3.asc&q=raw&suche=Vitrine&ordnung=price.desc&gruppe=status");
    // a filter goes in beside them; a reload reads the same
    await page.locator(".k2-fbar-add .k2-btn").click();
    await page.locator(".k2-fpick input").fill("lager");
    await page.getByRole("option", { name: "Lagerort" }).click();
    await page.locator(".k2-fpop").getByRole("option", { name: "Laden" }).click();
    expect(address(page)).toBe("sort=col3.asc&q=raw&location=shop&suche=Vitrine&ordnung=price.desc&gruppe=status");
    await page.reload();
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    expect(await statements(page)).toEqual(["Lagerort ist Laden"]);
    expect(await page.locator(".k2-order .k2-btn").first().textContent()).toBe("Preis · Höchster zuerst");
  });
});

test("phone: the sheet searches many fields in their groups; a field's verb is the first choice of its step", async () => {
  await withPage(
    "",
    async (page) => {
      await page.locator(".k2-fbar > .k2-btn").first().tap();
      const sheet = page.getByRole("dialog", { name: "Filter" });
      await sheet.waitFor();
      await steady(page);
      expect(await sheet.locator(".k2-fsheet-sec").allTextContents()).toEqual([
        "Häufig",
        "Preise",
        "Termine",
        "Herkunft",
        "Lager",
        "Darstellung",
      ]);
      const search = sheet.getByRole("searchbox", { name: "Filter suchen" });
      // the keyboard waits for a tap, as everywhere in the sheet
      expect(await page.evaluate(() => document.activeElement?.matches("input"))).toBe(false);
      const height = async () => (await sheet.boundingBox())?.height;
      const before = await height();
      await search.fill("epo");
      // fewer matches never move the sheet
      await settled(page);
      expect(await height()).toBe(before);
      expect(await sheet.locator(".k2-fsheet-row .k2-fsheet-label").allTextContents()).toEqual(["Epoche", "Sortierung", "Gruppierung"]);
      await sheet.locator(".k2-fsheet-row", { hasText: "Epoche" }).tap();
      await page.getByRole("dialog", { name: "Epoche" }).waitFor();
      await steady(page);
      await page.locator(".k2-fsheet .k2-fed-verb [data-select]").tap();
      await page.getByRole("option", { name: "ist nicht leer", exact: true }).tap();
      await page.waitForFunction(() => new URL(location.href).search === "?era.notEmpty=");
      await page.getByRole("button", { name: "Zurück", exact: true }).tap();
      await page.getByRole("dialog", { name: "Filter" }).waitFor();
      // the search stays while the person steps into a field and back
      expect(await search.inputValue()).toBe("epo");
      expect(await sheet.locator(".k2-fsheet-row", { hasText: "Epoche" }).textContent()).toContain("ist nicht leer");
    },
    { width: 390, touch: true },
  );
});

test("an option the app deleted, from its own old state, shows with a warning, and the bar still changes the list", async () => {
  await withPage("_stale=1", async (page) => {
    expect(await statements(page)).toEqual(["Status ist Eingeliefert oder gone"]);
    expect(
      await page
        .locator(".k2-stmt-b b", { hasText: "gone" })
        .getByRole("img", { name: /^Name nicht gefunden/ })
        .count(),
    ).toBe(1);
    await edit(page, "Status");
    await page.locator(".k2-fpop").getByRole("option", { name: "Online" }).click();
    // the address never holds the deleted option; the next state leaves it out
    expect(address(page)).toBe("_stale=1&status=consigned,online");
    expect(await statements(page)).toEqual(["Status ist Eingeliefert oder Online"]);
  });
});
