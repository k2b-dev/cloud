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
  });
});

test("choosing an order keeps the field; another field keeps the order shown, in its own words", async () => {
  await withPage(filterBundle, "", async (page) => {
    const button = page.locator(".k2-order .k2-btn").first();
    await button.click();
    await page.locator(".k2-menu").waitFor();
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
    await settled(page);
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
  expect(server).toEqual(["Familie Oswald", "Personen wählen", "Einlieferer wählen", "Nur mit Vollmacht", "Stadtwerke Auental"]);
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
    await settled(page);
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

// ── Numbers ────────────────────────────────────────────────────────────────────────────────────────────────────

test("a number range is built like a period: presets as a list with the tick at the end, then “Ab …” and “Bis …”", async () => {
  await withPage(filterBundle, "price=500..", async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const editor = page.locator(".k2-fpop");
    await editor.getByRole("option").first().waitFor();
    expect(await editor.getByRole("option").allTextContents()).toEqual(["bis 500 €", "500 € bis 2.000 €", "ab 2.000 €"]);
    // no pills, no fields side by side, no spinner in the editor
    expect(await editor.locator(".k2-btn[aria-pressed], input").count()).toBe(0);
    expect(await editor.locator(".k2-fed-bounds .k2-mi").allTextContents()).toEqual(["Ab500 €", "Bis…"]);
    await editor.getByRole("option", { name: "500 € bis 2.000 €" }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("price") === "500..2000");
    expect(await tickPlaces(page, ".k2-fpop .k2-opt")).toEqual(["none", "end", "none"]);
    expect(await editor.locator(".k2-fed-bounds .k2-mi").allTextContents()).toEqual(["Ab500 €", "Bis2.000 €"]);
    // "Bis …" opens its entry beside the editor, like a submenu; the field shows the bound in the locale
    await editor.locator(".k2-fed-bounds .k2-mi", { hasText: /^Bis/ }).click();
    const entry = page.locator(".k2-dpop .k2-nentry");
    await entry.waitFor();
    const [side, main] = [await entry.boundingBox(), await editor.boundingBox()];
    expect(side!.x).toBeGreaterThanOrEqual(main!.x + main!.width - 1);
    const field = entry.locator("input");
    expect(await field.inputValue()).toBe("2.000");
    expect(await entry.locator(".k2-fed-unit").textContent()).toBe("€");
    await field.fill("1.250,5");
    await field.press("Enter");
    await page.waitForFunction(() => new URL(location.href).searchParams.get("price") === "500..1250.5");
    expect(await page.locator(".k2-fbar-flow .k2-stmt-b").allTextContents()).toContain("Preis 500 € bis 1.250,5 €");
  });
});

test("phone: “Ab …” of a number range is the sheet's next step, “‹ Preis · Ab” in its head", async () => {
  await withPage(
    filterBundle,
    "price=500..",
    async (page) => {
      await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).tap();
      await page.getByRole("dialog", { name: "Preis" }).waitFor();
      await steady(page, '[role="dialog"]');
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi", { hasText: /^Ab/ }).tap();
      const step = page.getByRole("dialog", { name: "Preis · Ab" });
      await step.waitFor();
      expect(await step.locator('[data-slot="head"]').getByRole("button", { name: "Zurück", exact: true }).count()).toBe(1);
      const field = step.locator(".k2-nentry input");
      expect(await field.inputValue()).toBe("500");
      await field.fill("800");
      await step.getByRole("button", { name: "Anwenden" }).tap();
      await page.waitForFunction(() => new URL(location.href).searchParams.get("price") === "800..");
      // applied, the sheet is back at the field
      await page.getByRole("dialog", { name: "Preis" }).waitFor();
    },
    { width: 390, touch: true },
  );
});

test("a number field reads and shows the locale's numbers, without a spinner, the same on the server", async () => {
  expect(pickMarkup).toMatch(/inputmode="decimal"[^>]*value="1\.500"|value="1\.500"[^>]*inputmode="decimal"/);
  await withPage(
    pickBundle,
    "",
    async (page) => {
      const field = page.getByRole("textbox", { name: "Menge" });
      expect(await field.inputValue()).toBe("1.500");
      expect(await field.getAttribute("type")).toBe("text");
      expect(await field.getAttribute("inputmode")).toBe("decimal");
      const sent = page.locator('input[type="hidden"][name="quantity"]');
      expect(await sent.inputValue()).toBe("1500");
      await field.fill("2.500,5");
      expect(await page.evaluate(() => window.__picks?.changes.at(-1))).toBe("quantity=2500.5");
      expect(await sent.inputValue()).toBe("2500.5");
      // what is typed stays while typing; leaving the field shows it in the locale's form
      await field.fill("2500,5");
      await field.blur();
      expect(await field.inputValue()).toBe("2.500,5");
      // below `min` and text that is no number stop a form, with a short message
      await field.fill("0");
      expect(await field.evaluate((input) => (input as HTMLInputElement).validationMessage)).toBe("Mindestens 1.");
      await field.fill("zwei");
      expect(await field.evaluate((input) => (input as HTMLInputElement).validationMessage)).toBe("Gib eine Zahl ein.");
    },
    { markup: pickMarkup },
  );
});

// ── Review fixes: what a form sends, validity, reset, disabled, stale names, open surfaces ────────────────────────

/** Wraps the page in a form, as an app's form holds its fields; a send that the browser lets through marks the body. */
const inForm = (page: Page) =>
  page.evaluate(() => {
    const form = document.createElement("form");
    const root = document.getElementById("root")!;
    root.replaceWith(form);
    form.append(root);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      document.body.dataset.sent = "";
    });
  });
const formData = (page: Page) =>
  page.evaluate(() => [...new FormData(document.querySelector("form")!)].map(([name, value]) => [name, String(value)]));

test("a form sends each number once, as the plain number, and nothing of a disabled field", async () => {
  await withPage(pickBundle, "", async (page) => {
    await inForm(page);
    // the whole form: the customer, the plain quantity; nothing of the disabled agent, store or slots
    expect(await formData(page)).toEqual([
      ["customer", "k-17"],
      ["quantity", "1500"],
    ]);
    await page.getByRole("textbox", { name: "Menge" }).fill("2.500,5");
    expect(await formData(page)).toEqual([
      ["customer", "k-17"],
      ["quantity", "2500.5"],
    ]);
  });
  // the server sends the same: one field under the name, the plain number
  expect([...pickMarkup.matchAll(/name="quantity"/g)].length).toBe(1);
  expect([...pickMarkup.matchAll(/name="slots"/g)].length).toBe(1);
  expect(pickMarkup).toMatch(
    /<input[^>]*type="hidden"[^>]*name="slots"[^>]*disabled|<input[^>]*disabled[^>]*type="hidden"[^>]*name="slots"/,
  );
});

test("a number field's validity follows its value from outside, its bounds and what is typed", async () => {
  await withPage(pickBundle, "quantity=0", async (page) => {
    const field = page.getByRole("textbox", { name: "Menge" });
    const message = () => field.evaluate((input) => (input as HTMLInputElement).validationMessage);
    // a value below `min` is invalid from the start
    expect(await message()).toBe("Mindestens 1.");
    await field.fill("zwei");
    expect(await message()).toBe("Gib eine Zahl ein.");
    // the app sets a good value: the message goes
    await page.evaluate(() => window.__picks?.setQuantity?.("2"));
    await page.waitForFunction(
      () => (document.querySelector('[data-k2-part="Input"] input[inputmode="decimal"]') as HTMLInputElement).value === "2",
    );
    expect(await message()).toBe("");
  });
});

test("a number field never sends a number other than the one shown: no rounding, no Infinity", async () => {
  await withPage(pickBundle, "", async (page) => {
    await inForm(page);
    const field = page.getByRole("textbox", { name: "Menge" });
    const message = () => field.evaluate((input) => (input as HTMLInputElement).validationMessage);
    // more digits than a number holds exactly: refused, never sent rounded
    await field.fill("9007199254740993");
    expect(await message()).toBe("Zu viele Stellen für eine Zahl.");
    await field.fill("9".repeat(400));
    expect(await message()).toBe("Zu viele Stellen für eine Zahl.");
    expect(await formData(page)).not.toContainEqual(["quantity", "Infinity"]);
    // a value from outside in a form the field cannot show exactly stays as it is, and says so
    await page.evaluate(() => window.__picks?.setQuantity?.("1e-21"));
    await page.waitForFunction(
      () => (document.querySelector('[data-k2-part="Input"] input[inputmode="decimal"]') as HTMLInputElement).value === "1e-21",
    );
    expect(await message()).toBe("Gib eine Zahl ein.");
    expect(await formData(page)).toContainEqual(["quantity", "1e-21"]);
  });
});

test("a form's reset puts a number field back as a whole: what it shows, what it sends and what the app holds", async () => {
  await withPage(pickBundle, "", async (page) => {
    await inForm(page);
    const field = page.getByRole("textbox", { name: "Menge" });
    await field.fill("4");
    expect(await formData(page)).toContainEqual(["quantity", "4"]);
    await page.evaluate(() => document.querySelector("form")?.reset());
    await page.waitForFunction(() => window.__picks?.changes.at(-1) === "quantity=1500");
    expect(await field.inputValue()).toBe("1.500");
    expect(await formData(page)).toContainEqual(["quantity", "1500"]);
  });
});

test("a late answer of an aborted search never renames what the newer one named", async () => {
  await withPage(pickBundle, "", async (page) => {
    const customer = page.getByRole("combobox", { name: "Kunde" });
    await customer.click();
    await page.waitForFunction(() => window.__picks?.calls.length === 1);
    await page.evaluate(() => window.__picks?.answer());
    const search = page.getByRole("searchbox", { name: "Kunde suchen" });
    await search.pressSequentially("Archi");
    await page.waitForFunction(() => window.__picks?.calls.at(-1)?.query === "Archi");
    await search.pressSequentially("t");
    await page.waitForFunction(() => window.__picks?.calls.at(-1)?.query === "Archit");
    await page.evaluate(() => window.__picks?.answer("Winter (neu)"));
    await page.getByRole("option", { name: /Winter \(neu\)/ }).click();
    await page.locator(".k2-lpop").waitFor({ state: "hidden" });
    expect(await customer.textContent()).toBe("Winter (neu)");
    // the aborted "Archi" answers late with an old name
    await page.evaluate(() => window.__picks?.answerStale("Winter (alt)"));
    await page.waitForTimeout(100);
    expect(await customer.textContent()).toBe("Winter (neu)");
  });
});

test("disabled lookups send nothing, and a disabled required one does not hold the form back", async () => {
  await withPage(pickBundle, "", async (page) => {
    await inForm(page);
    const consignor = page.getByRole("combobox", { name: "Einlieferer" });
    await consignor.click();
    await page.waitForFunction(() => window.__picks?.calls.length === 1);
    await page.evaluate(() => window.__picks?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).click();
    await page.locator(".k2-lpop").waitFor({ state: "hidden" });
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe("");
    expect(await formData(page)).toEqual([
      ["customer", "k-17"],
      ["quantity", "1500"],
      ["consignor", "k-44"],
    ]);
  });
});

test("an optional single LookupSelect can be cleared with a named deed", async () => {
  await withPage(pickBundle, "", async (page) => {
    await inForm(page);
    const customer = page.getByRole("combobox", { name: "Kunde" });
    await customer.click();
    await page.getByRole("button", { name: "Auswahl entfernen" }).click();
    await page.locator(".k2-lpop").waitFor({ state: "hidden" });
    expect(await customer.textContent()).toBe("Kunde wählen");
    expect(await page.evaluate(() => window.__picks?.changes)).toEqual(["customer="]);
    expect(await formData(page)).toEqual([["quantity", "1500"]]);
    // a required one has no such deed
    await page.getByRole("combobox", { name: "Einlieferer" }).click();
    await page.locator(".k2-lpop").waitFor();
    expect(await page.getByRole("button", { name: "Auswahl entfernen" }).count()).toBe(0);
  });
});

test("LookupSelect's field says which surface is open and points at it, on the computer and the phone", async () => {
  await withPage(pickBundle, "", async (page) => {
    const customer = page.getByRole("combobox", { name: "Kunde" });
    expect(await customer.getAttribute("aria-expanded")).toBe("false");
    await customer.click();
    await page.locator(".k2-lpop").waitFor();
    expect(await customer.getAttribute("aria-expanded")).toBe("true");
    const controls = await customer.getAttribute("aria-controls");
    expect(await page.evaluate((id) => document.getElementById(id ?? "")?.classList.contains("k2-lpop"), controls)).toBe(true);
  });
  await withPage(
    pickBundle,
    "",
    async (page) => {
      const customer = page.getByRole("combobox", { name: "Kunde" });
      await customer.tap();
      await page.getByRole("dialog", { name: "Kunde" }).waitFor();
      expect(await customer.getAttribute("aria-expanded")).toBe("true");
      const controls = await customer.getAttribute("aria-controls");
      expect(await page.evaluate((id) => document.getElementById(id ?? "")?.getAttribute("role"), controls)).toBe("dialog");
    },
    { width: 390, touch: true },
  );
});

test("a number range's refusal speaks of “Ab” and “Bis”", async () => {
  await withPage(filterBundle, "price=500..", async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    await page.locator(".k2-fpop .k2-fed-bounds .k2-mi", { hasText: /^Bis/ }).click();
    const field = page.locator(".k2-dpop .k2-nentry input");
    await field.fill("300");
    await field.press("Enter");
    await page.getByText("„Ab“ ist größer als „Bis“. Der Filter gilt so nicht.").waitFor();
  });
});
