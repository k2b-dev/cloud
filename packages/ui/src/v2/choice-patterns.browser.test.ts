import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-filter.demo";
import type {} from "../../test/v2-lookup-select.demo";

// One way to choose, everywhere in v2 (UX sweep 25.11., items 4–7): a sort reads in words in two choices, "Sortieren
// nach" and "Reihenfolge"; one choice puts its tick at the end of the row (Menu, Select, a filter's options, the
// phone's sheet); a step deeper in the phone's sheet goes back from the sheet's head ("‹ Preis"); and a form picks a
// customer or a person from values that load, with `LookupSelect`.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://choice.test";

let browser: Browser;
let filterBundle: string;
let pickBundle: string;
let pickMarkup: string;
beforeAll(async () => {
  [filterBundle, pickBundle, pickMarkup, browser] = await Promise.all([
    demoBundle("../v2-filter"),
    demoBundle("../v2-lookup-select"),
    serverMarkup("../v2-lookup-select"),
    launchBrowser(),
  ]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (
  bundle: string,
  search: string,
  run: (page: Page) => Promise<void>,
  { width = 1440, touch = false, markup = "" }: { width?: number; touch?: boolean; markup?: string } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    }),
  );
  try {
    await page.goto(`${origin}/page${search ? `?${search}` : ""}`);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Waits until the element keeps its place for two frames inside the window, such as a sheet once it has slid up. */
const steady = async (page: Page, selector: string) => {
  await page.evaluate((s) => document.querySelector(s)?.removeAttribute("data-test-top"), selector);
  await page.waitForFunction(
    (s) => {
      const element = document.querySelector(s);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const last = Number(element.getAttribute("data-test-top") ?? "NaN");
      element.setAttribute("data-test-top", String(box.top));
      return box.top === last && box.bottom <= innerHeight + 1;
    },
    selector,
    { polling: 100, timeout: 5000 },
  );
};

/**
 * Where the tick of each row stands: `end` when it is the row's last part and its right edge meets the row's padding,
 * `start` when it comes before the words, `none` without a tick.
 */
const tickPlaces = (page: Page, rows: string) =>
  page.locator(rows).evaluateAll((items) =>
    items.map((item) => {
      const tick = [...item.querySelectorAll(".ti-check")].find((icon) => icon.getClientRects().length > 0);
      if (!tick) return "none";
      const words = item.querySelector(".k2-mi-label, .k2-opt-label");
      const row = item.getBoundingClientRect();
      const mark = tick.getBoundingClientRect();
      if (words && mark.left < words.getBoundingClientRect().left) return "start";
      const padding = Number.parseFloat(getComputedStyle(item).paddingRight);
      return Math.abs(row.right - padding - mark.right) <= 1 ? "end" : `at ${Math.round(row.right - mark.right)}px from the end`;
    }),
  );

// ── Sort ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("the sort reads in words: “Sortieren nach” the fields, “Reihenfolge” by what the field orders, no arrows", async () => {
  await withPage(filterBundle, "", async (page) => {
    const button = page.locator(".k2-order .k2-btn").first();
    expect(await button.textContent()).toBe("Eingang · Neueste zuerst");
    await button.click();
    const menu = page.locator(".k2-menu");
    await menu.waitFor();
    expect(await menu.locator(".k2-mh").allTextContents()).toEqual(["Sortieren nach", "Reihenfolge"]);
    expect(await menu.getByRole("group", { name: "Sortieren nach" }).getByRole("menuitemradio").allTextContents()).toEqual([
      "Preis",
      "Eingang",
    ]);
    expect(await menu.getByRole("group", { name: "Reihenfolge" }).getByRole("menuitemradio").allTextContents()).toEqual([
      "Neueste zuerst",
      "Älteste zuerst",
    ]);
    expect(await menu.textContent()).not.toMatch(/[↑↓]/);
    // the order of the field shown
    await page.getByRole("menuitemradio", { name: "Älteste zuerst" }).click();
    expect(new URL(page.url()).searchParams.get("sort")).toBe("received.asc");
    expect(await button.textContent()).toBe("Eingang · Älteste zuerst");
    // another field keeps the order shown, in its own words
    await button.click();
    await page.getByRole("menuitemradio", { name: "Preis" }).click();
    expect(new URL(page.url()).searchParams.get("sort")).toBe("price.asc");
    expect(await button.textContent()).toBe("Preis · Niedrigster zuerst");
    await button.click();
    expect(await page.getByRole("group", { name: "Reihenfolge" }).getByRole("menuitemradio").allTextContents()).toEqual([
      "Höchster zuerst",
      "Niedrigster zuerst",
    ]);
    // one choice: the tick at the end of the chosen row, in both sections
    expect(await tickPlaces(page, ".k2-menu .k2-mi")).toEqual(["end", "none", "none", "end"]);
  });
});

test("phone: the sort sheet has the same two choices, each tick at the end of its row", async () => {
  await withPage(
    filterBundle,
    "sort=price.desc",
    async (page) => {
      await page.locator(".k2-fbar-order .k2-btn").first().tap();
      await page.getByRole("dialog", { name: "Sortierung" }).waitFor();
      await steady(page, '[role="dialog"]');
      expect(await page.locator(".k2-fsheet-sec").allTextContents()).toEqual(["Sortieren nach", "Reihenfolge"]);
      expect(await page.getByRole("listbox", { name: "Reihenfolge" }).getByRole("option").allTextContents()).toEqual([
        "Höchster zuerst",
        "Niedrigster zuerst",
      ]);
      expect(await tickPlaces(page, ".k2-fsheet .k2-opt")).toEqual(["end", "none", "end", "none"]);
      await page.getByRole("option", { name: "Niedrigster zuerst" }).tap();
      await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "price.asc");
    },
    { width: 390, touch: true },
  );
});

// ── One choice: the tick at the end ────────────────────────────────────────────────────────────────────────────

test("a filter's one choice (a period preset) puts its tick at the end; several put their box first", async () => {
  await withPage(filterBundle, "received=last-30d&status=consigned", async (page) => {
    await page.getByRole("button", { name: /^Filter Eingang .* bearbeiten$/ }).click();
    await page.locator(".k2-fpop [role=option]").first().waitFor();
    expect(await tickPlaces(page, ".k2-fpop .k2-opt")).toEqual(["none", "end"]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Filter Status .* bearbeiten$/ }).click();
    await page.locator(".k2-fpop [role=option]").first().waitFor();
    expect((await tickPlaces(page, ".k2-fpop .k2-opt"))[0]).toBe("start");
  });
});

// ── The sheet's head ───────────────────────────────────────────────────────────────────────────────────────────

test("phone: a step deeper in the filter sheet goes back from the sheet's head, “‹ Preis”, without a line of its own", async () => {
  await withPage(
    filterBundle,
    "price=500..",
    async (page) => {
      await page.getByRole("button", { name: /^Filter\s*\d*$/ }).tap();
      await page.getByRole("dialog", { name: "Filter" }).waitFor();
      await steady(page, '[role="dialog"]');
      // the list of fields has no way back
      expect(await page.getByRole("button", { name: "Zurück", exact: true }).count()).toBe(0);
      await page.locator(".k2-fsheet-row", { hasText: "Preis" }).tap();
      const sheet = page.getByRole("dialog", { name: "Preis" });
      await sheet.waitFor();
      const back = sheet.getByRole("button", { name: "Zurück", exact: true });
      const title = sheet.locator(".k2-dialog-title");
      const [arrow, words] = [await back.boundingBox(), await title.boundingBox()];
      if (!arrow || !words) throw new Error("no back or title");
      // in the head, before the title, on its line
      expect(await back.evaluate((node) => node.closest('[data-slot="head"]') !== null)).toBe(true);
      expect(arrow.x + arrow.width).toBeLessThanOrEqual(words.x);
      expect(Math.abs(arrow.y + arrow.height / 2 - (words.y + words.height / 2))).toBeLessThanOrEqual(1);
      // the editor starts right under the head: no row that holds only "‹"
      expect(await sheet.locator(".k2-dialog-body > .k2-fsheet > :first-child").getAttribute("class")).toContain("k2-fed");
      await back.tap();
      await page.getByRole("dialog", { name: "Filter" }).waitFor();
      expect(await page.getByRole("button", { name: "Zurück", exact: true }).count()).toBe(0);
    },
    { width: 390, touch: true },
  );
});

// ── LookupSelect ───────────────────────────────────────────────────────────────────────────────────────────────

const calls = (page: Page) =>
  page.evaluate(() => (window.__picks?.calls ?? []).map((call) => ({ query: call.query, aborted: call.aborted() })));

test("LookupSelect: the first picture is the server's; the field reads like a Select with the chosen name", async () => {
  const server = [...pickMarkup.matchAll(/<[^>]*data-k2-part="LookupSelect"[^>]*>(.*?)<\/button>/gs)].map((match) =>
    match[1]?.replace(/<[^>]*>/g, ""),
  );
  expect(server).toEqual(["Familie Oswald", "Personen wählen", "Einlieferer wählen"]);
  await withPage(
    pickBundle,
    "",
    async (page) => {
      const customer = page.getByRole("combobox", { name: "Kunde" });
      expect(await customer.textContent()).toBe("Familie Oswald");
      expect(await page.getByRole("combobox", { name: "Ansprechpersonen" }).textContent()).toBe("Personen wählen");
      expect(await customer.getAttribute("aria-required")).toBeNull();
      expect(await page.getByRole("combobox", { name: "Einlieferer" }).getAttribute("aria-required")).toBe("true");
      expect((await customer.boundingBox())?.height).toBe(36);
      expect(await page.locator('input[type="hidden"][name="customer"]').inputValue()).toBe("k-17");
      // nothing loads before the list opens
      expect(await calls(page)).toEqual([]);
    },
    { markup: pickMarkup },
  );
});

test("LookupSelect: Arrow down opens, the search takes the focus, a newer search aborts the older, Enter chooses one", async () => {
  await withPage(pickBundle, "", async (page) => {
    const customer = page.getByRole("combobox", { name: "Kunde" });
    await customer.focus();
    await page.keyboard.press("ArrowDown");
    const panel = page.locator(".k2-lpop");
    await panel.waitFor();
    const search = page.getByRole("searchbox", { name: "Kunde suchen" });
    await page.waitForFunction(() => document.activeElement?.matches(".k2-lpop .k2-lookup-search input") === true);
    // at least as wide as its field
    const [field, popup] = [await customer.boundingBox(), await panel.boundingBox()];
    expect(popup!.width).toBeGreaterThanOrEqual(field!.width - 0.5);
    await page.evaluate(() => window.__picks?.answer());
    await search.pressSequentially("ber");
    await page.waitForFunction(() => window.__picks?.calls.at(-1)?.query === "ber");
    await search.pressSequentially("gm");
    await page.waitForFunction(() => window.__picks?.calls.at(-1)?.query === "bergm");
    // the older search was aborted when the newer one began; the newest runs
    expect((await calls(page)).slice(1).map((call) => call.aborted)).toEqual([true, false]);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).waitFor();
    await search.press("ArrowDown");
    // the chosen customer stands first under "Gewählt"; the arrows only move, they choose nothing
    await page.keyboard.press("ArrowDown");
    expect(await panel.isVisible()).toBe(true);
    expect(await page.evaluate(() => window.__picks?.changes)).toEqual([]);
    await page.keyboard.press("Enter");
    await panel.waitFor({ state: "hidden" });
    expect(await page.evaluate(() => window.__picks?.changes)).toEqual(["customer=k-44"]);
    expect(await customer.textContent()).toBe("Haus Bergmann");
    expect(await page.locator('input[type="hidden"][name="customer"]').inputValue()).toBe("k-44");
    // the focus is back on the field
    expect(await customer.evaluate((node) => node === document.activeElement)).toBe(true);
  });
});

test("LookupSelect: Escape closes and aborts the load that runs; a failed load offers to try again", async () => {
  await withPage(pickBundle, "", async (page) => {
    const customer = page.getByRole("combobox", { name: "Kunde" });
    await customer.click();
    await page.locator(".k2-lpop").waitFor();
    await page.waitForFunction(() => window.__picks?.calls.length === 1);
    await page.keyboard.press("Escape");
    await page.locator(".k2-lpop").waitFor({ state: "hidden" });
    expect(await calls(page)).toEqual([{ query: "", aborted: true }]);
    expect(await customer.evaluate((node) => node === document.activeElement)).toBe(true);
    // a failure keeps the field as it is and says so in the panel
    await customer.click();
    await page.waitForFunction(() => window.__picks?.calls.length === 2);
    await page.evaluate(() => window.__picks?.fail());
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.waitForFunction(() => window.__picks?.calls.length === 3);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Stadtwerke Auental/ }).waitFor();
    expect(await customer.textContent()).toBe("Familie Oswald");
  });
});

test("LookupSelect multiple: each press ticks a box first and the list stays open; one choice ticks at the end", async () => {
  await withPage(pickBundle, "", async (page) => {
    const people = page.getByRole("combobox", { name: "Ansprechpersonen" });
    await people.click();
    await page.waitForFunction(() => window.__picks?.calls.length === 1);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).click();
    await page.getByRole("option", { name: /Stadtwerke Auental/ }).click();
    expect(await page.locator(".k2-lpop").isVisible()).toBe(true);
    expect((await tickPlaces(page, ".k2-lpop .k2-opt")).slice(0, 2)).toEqual(["start", "start"]);
    await page.keyboard.press("Escape");
    expect(await people.textContent()).toBe("Haus Bergmann, Stadtwerke Auental");
    expect(
      await page.locator('input[type="hidden"][name="people"]').evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value)),
    ).toEqual(["k-44", "k-31"]);
    // the one customer: its tick at the end
    await page.getByRole("combobox", { name: "Kunde" }).click();
    await page.waitForFunction(() => window.__picks?.calls.length === 2);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Stadtwerke Auental/ }).waitFor();
    expect((await tickPlaces(page, ".k2-lpop .k2-opt"))[0]).toBe("end");
  });
});

test("LookupSelect on the phone: a tap opens the sheet named after the field; a choice closes it", async () => {
  await withPage(
    pickBundle,
    "",
    async (page) => {
      await page.getByRole("combobox", { name: "Kunde" }).tap();
      const sheet = page.getByRole("dialog", { name: "Kunde" });
      await sheet.waitFor();
      await steady(page, '[role="dialog"]');
      await page.waitForFunction(() => window.__picks?.calls.length === 1);
      await page.evaluate(() => window.__picks?.answer());
      await sheet.getByRole("option", { name: /Architekturbüro Winter/ }).tap();
      await sheet.waitFor({ state: "hidden" });
      expect(await page.getByRole("combobox", { name: "Kunde" }).textContent()).toBe("Architekturbüro Winter");
    },
    { width: 390, touch: true },
  );
});

test("LookupSelect required: the form is not sent while it is empty, and is once a value is chosen", async () => {
  await withPage(pickBundle, "", async (page) => {
    await page.evaluate(() => {
      const form = document.createElement("form");
      const root = document.getElementById("root")!;
      root.replaceWith(form);
      form.append(root);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        document.body.dataset.sent = "";
      });
    });
    const consignor = page.getByRole("combobox", { name: "Einlieferer" });
    expect(await consignor.textContent()).toBe("Einlieferer wählen");
    expect(await page.locator('input[type="hidden"][name="consignor"]').count()).toBe(0);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    expect(await page.evaluate(() => document.body.dataset.sent)).toBeUndefined();
    // the browser points at the field that is missing
    expect(await consignor.evaluate((node) => node === document.activeElement)).toBe(true);
    await consignor.click();
    await page.waitForFunction(() => window.__picks?.calls.length === 1);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).click();
    await page.locator(".k2-lpop").waitFor({ state: "hidden" });
    expect(await page.locator('input[type="hidden"][name="consignor"]').inputValue()).toBe("k-44");
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe("");
  });
});
