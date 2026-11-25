import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-filter.demo";
import { heights } from "./tokens";

// FilterBar, Lookup and ListOrder of v2 in a real engine with v2.css, on the Artikel list of the approved concept
// (ui-v2-filter-konzept v4): statements that wrap between whole statements and are never cut, focus rings that no
// container clips, no shift when an editor opens or a lookup loads, the lookup's wait, abort, failure and retry, the
// keys, the address as the one state (reload, back), the phone's line and sheet, and saving a view into a store.
// The page has a real address (a routed origin), because the bar writes the history.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://filter.test";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-filter"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const articles = "status=consigned,photographed&category=furniture,clocks&price=500..";

const withPage = async (search: string, run: (page: Page) => Promise<void>, { width = 1440, touch = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    }),
  );
  try {
    await page.goto(`${origin}/artikel${search ? `?${search}` : ""}`);
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
const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`no box for ${selector}`);
  return found;
};
/** Waits until the element keeps its place for two frames, such as a sheet once it has slid up. */
const steady = (page: Page, selector: string) =>
  page.waitForFunction(
    (s) => {
      const element = document.querySelector(s);
      if (!element) return false;
      // in a loaded WebKit the sheet can wait below the window for a moment before it slides: standing still is not
      // enough, it must stand inside the window
      const box = element.getBoundingClientRect();
      const last = Number(element.getAttribute("data-test-top") ?? "NaN");
      element.setAttribute("data-test-top", String(box.top));
      return box.top === last && box.bottom <= innerHeight + 1;
    },
    selector,
    { polling: 100, timeout: 5000 },
  );
const calls = (page: Page) =>
  page.evaluate(() => (window.__lookup?.calls ?? []).map((call) => ({ query: call.query, aborted: call.aborted() })));

test("the statements read as sentences, joined by “und”, from the address alone", async () => {
  await withPage(`${articles}&consignor=c-1005`, async (page) => {
    expect(await statements(page)).toEqual([
      "Status ist Eingeliefert oder Fotografiert",
      "Kategorie ist Möbel oder Uhren",
      "Preis ab 500 €",
      "Einlieferer ist Nachlass Kessler",
    ]);
    expect(await page.locator(".k2-fbar-and").allTextContents()).toEqual(["und", "und", "und"]);
    expect(await page.getByRole("group", { name: "Filter" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Filter Status ist Eingeliefert oder Fotografiert bearbeiten" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Filter Status entfernen" }).count()).toBe(1);
  });
});

test("from 768 px the bar wraps between whole statements; “+ Filter” and “Zurücksetzen” follow the last one", async () => {
  const many = `${articles}&location=hall-b,workshop&received=last-30d&consignor=c-1001,c-1002,c-1004,c-1006`;
  for (const width of [1440, 1024, 768]) {
    await withPage(
      many,
      async (page) => {
        const bar = await box(page, ".k2-fbar");
        const items = await page.locator(".k2-fbar-flow > *").evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            const words = node.querySelector(".k2-stmt-b");
            return { left: rect.left, right: rect.right, top: rect.top, cut: words ? words.scrollWidth > words.clientWidth + 1 : false };
          }),
        );
        // nothing leaves the bar, no statement is cut
        for (const item of items) {
          expect(item.left).toBeGreaterThanOrEqual(bar.x);
          expect(item.right).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
          expect(item.cut).toBe(false);
        }
        const rows = new Set(items.map((item) => Math.round(item.top)));
        if (width < 1440) expect(rows.size).toBeGreaterThan(1);
        // "+ Filter" and "Zurücksetzen" stand after the last statement
        const add = await box(page, ".k2-fbar-add");
        const last = await page.locator(".k2-fbar-item").last().boundingBox();
        if (!last) throw new Error("no last statement");
        expect(add.y > last.y + 1 || add.x > last.x).toBe(true);
        // each further line is 34 px: 28 for the control, 6 between
        const lines = rows.size;
        expect(Math.round(bar.height)).toBe(heights.bar + (lines - 1) * 34 + 1);
        // "Ansicht ▾" stays at the end of the first line
        const view = await box(page, ".k2-fbar-end");
        expect(Math.round(view.y)).toBe(Math.round(bar.y + 6));
      },
      { width },
    );
  }
}, 20_000);

test("a focus ring is never cut: no container of a statement clips it, on the desktop and on the phone", async () => {
  for (const width of [1440, 390]) {
    await withPage(
      articles,
      async (page) => {
        const clipped = await page
          .locator(".k2-stmt")
          .first()
          .evaluate((statement) => {
            const ring = 3;
            const own = statement.getBoundingClientRect();
            const found: string[] = [];
            for (let node = statement.parentElement; node && node !== document.body; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.overflowX === "visible" && style.overflowY === "visible") continue;
              const rect = node.getBoundingClientRect();
              if (own.top - ring < rect.top || own.bottom + ring > rect.bottom) found.push(`${node.className} (${style.overflowY})`);
            }
            return found;
          });
        expect(clipped).toEqual([]);
      },
      { width, touch: width < 768 },
    );
  }
});

test("nothing moves when a statement is hovered, focused or opened, or when the lookup loads", async () => {
  await withPage(articles, async (page) => {
    const before = await box(page, ".k2-fbar-item:first-child .k2-stmt");
    const status = await box(page, "[data-status-row]");
    await page.locator(".k2-fbar-item:first-child .k2-stmt").hover();
    expect(await box(page, ".k2-fbar-item:first-child .k2-stmt")).toEqual(before);
    await page.keyboard.press("Tab");
    await page.locator(".k2-fbar-item:first-child .k2-stmt-b").focus();
    expect(await box(page, ".k2-fbar-item:first-child .k2-stmt")).toEqual(before);
    await page.keyboard.press("Enter");
    await page.locator(".k2-fpop").waitFor();
    expect(await box(page, ".k2-fbar-item:first-child .k2-stmt")).toEqual(before);
    expect(await box(page, "[data-status-row]")).toEqual(status);
  });
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    await page.locator(".k2-lookup").waitFor();
    const state = await box(page, ".k2-lookup-state");
    // the placeholders take the place of three rows from the start and only show after 150 ms
    expect(Math.round(state.height)).toBeGreaterThanOrEqual(104);
    expect(await page.locator(".k2-lookup-skel").evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
    await page.waitForTimeout(250);
    expect(await page.locator(".k2-lookup-skel").evaluate((node) => getComputedStyle(node).visibility)).toBe("visible");
    expect(await box(page, ".k2-lookup-state")).toEqual(state);
  });
});

test("lookup: typing waits, a newer search aborts the one that runs, and closing aborts too", async () => {
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    await page.getByRole("searchbox", { name: "Einlieferer suchen" }).waitFor();
    await page.evaluate(() => window.__lookup?.answer());
    expect(await calls(page)).toEqual([{ query: "", aborted: false }]);
    // typing within 200 ms loads once, for the whole word
    await page.keyboard.type("ber", { delay: 20 });
    await page.waitForTimeout(260);
    expect((await calls(page)).map((call) => call.query)).toEqual(["", "ber"]);
    // a newer search while one runs aborts it
    await page.keyboard.type("g");
    await page.waitForTimeout(260);
    const after = await calls(page);
    expect(after.map((call) => call.query)).toEqual(["", "ber", "berg"]);
    expect(after[1]?.aborted).toBe(true);
    expect(after[2]?.aborted).toBe(false);
    await page.evaluate(() => window.__lookup?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).waitFor();
    expect(await page.locator(".k2-lookup .k2-opt-head").allTextContents()).toEqual(["Gewählt", "Treffer für „berg“"]);
    // the chosen value stays on top
    expect(await page.locator(".k2-lookup [role=option]").first().textContent()).toContain("Nachlass Kessler");
    // closing while a load runs aborts it
    await page.keyboard.type("x");
    await page.waitForTimeout(260);
    await page.keyboard.press("Escape");
    await page.locator(".k2-fpop").waitFor({ state: "detached" });
    expect((await calls(page)).at(-1)).toEqual({ query: "bergx", aborted: true });
  });
});

test("lookup: a failed load says so, keeps the choice, and “Erneut versuchen” loads again", async () => {
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    await page.getByRole("searchbox", { name: "Einlieferer suchen" }).waitFor();
    await page.evaluate(() => window.__lookup?.fail());
    await page.getByText("Konnte nicht geladen werden. Deine Auswahl bleibt.").waitFor();
    expect(await page.locator(".k2-lookup [role=option]").allTextContents()).toEqual(["Nachlass KesslerWaldkirch"]);
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    expect((await calls(page)).length).toBe(2);
    await page.evaluate(() => window.__lookup?.answer());
    await page.getByRole("option", { name: /Antik Weber KG/ }).waitFor();
    // choosing a loaded value applies at once and names it in the statement
    await page.getByRole("option", { name: /Antik Weber KG/ }).click();
    expect(new URL(page.url()).searchParams.get("consignor")).toBe("c-1005,c-1004");
    expect(await statements(page)).toEqual(["Einlieferer ist Nachlass Kessler oder Antik Weber KG"]);
  });
});

test("keys: Enter opens the editor in its values, Space ticks, Escape returns to the statement, × moves on", async () => {
  await withPage(articles, async (page) => {
    await page.locator(".k2-fbar-item:first-child .k2-stmt-b").focus();
    await page.keyboard.press("Enter");
    await page.locator(".k2-fpop [role=listbox]").waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    expect(await page.locator(".k2-fpop [role=listbox]").getAttribute("aria-multiselectable")).toBe("true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    expect(new URL(page.url()).searchParams.get("status")).toBe("consigned,photographed,online");
    await page.keyboard.press("Escape");
    await page.locator(".k2-fpop").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.classList.contains("k2-stmt-b"))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Status ist Eingeliefert, Fotografiert oder Online");
    // removing a statement hands the focus to the next one
    await page.getByRole("button", { name: "Filter Status entfernen" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.textContent === "Kategorie ist Möbel oder Uhren");
    expect(new URL(page.url()).searchParams.has("status")).toBe(false);
  });
});

test("the address is the state: one history entry per editor, back restores, a reload shows the same", async () => {
  await withPage(articles, async (page) => {
    const length = await page.evaluate(() => history.length);
    await page.locator(".k2-fbar-item:first-child .k2-stmt-b").click();
    await page.getByRole("option", { name: /Online/ }).click();
    await page.getByRole("option", { name: /Reserviert/ }).click();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    const url = page.url();
    expect(new URL(url).searchParams.get("status")).toBe("consigned,photographed,online,reserved");
    // more than three values: "A, B oder 2 weitere"
    expect((await statements(page))[0]).toBe("Status ist Eingeliefert, Fotografiert oder 2 weitere");
    // sort and group from the status row write the address too
    await page.getByRole("button", { name: /Eingang/ }).click();
    await page.getByRole("menuitemradio", { name: "Preis ↓" }).click();
    expect(new URL(page.url()).searchParams.get("sort")).toBe("price.desc");
    await page.goBack();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("sort"));
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("status") === "consigned,photographed");
    expect((await statements(page))[0]).toBe("Status ist Eingeliefert oder Fotografiert");
    // "Zurücksetzen" returns to the view (here: no filters) in one step
    await page.getByRole("button", { name: "Zurücksetzen" }).click();
    expect(new URL(page.url()).search).toBe("");
    expect(await statements(page)).toEqual([]);
    expect(await page.getByRole("button", { name: "Zurücksetzen" }).count()).toBe(0);
  });
  // a reload of a written address shows the same statements
  await withPage("status=consigned,photographed,online,reserved&sort=price.desc", async (page) => {
    expect((await statements(page))[0]).toBe("Status ist Eingeliefert, Fotografiert oder 2 weitere");
    expect(await page.locator(".k2-order .k2-btn").first().textContent()).toContain("Preis ↓");
  });
});

test("“+ Filter” adds a dashed statement that applies once it has a value; a range applies on Enter", async () => {
  await withPage(articles, async (page) => {
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: /Lagerort/ }).click();
    await page.locator(".k2-stmt[data-draft]").waitFor();
    expect(await page.locator(".k2-stmt[data-draft] .k2-stmt-b").textContent()).toBe("Lagerort ist …");
    expect(new URL(page.url()).searchParams.has("location")).toBe(false);
    await page.getByRole("option", { name: "Halle B" }).click();
    expect(new URL(page.url()).searchParams.get("location")).toBe("hall-b");
    expect(await page.locator(".k2-stmt[data-draft]").count()).toBe(0);
    await page.keyboard.press("Escape");
    // the range: "Von" above "Bis" is refused with a sentence; Enter applies
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const to = page.locator(".k2-fpop .k2-fed-field").nth(1).locator("input");
    await to.fill("300");
    await to.press("Enter");
    await page.getByText("„Von“ ist größer als „Bis“. Der Filter gilt so nicht.").waitFor();
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..");
    await to.fill("2000");
    await to.press("Enter");
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..2000");
    expect(await statements(page)).toContain("Preis 500 € bis 2.000 €");
  });
});

test("at the length limit of the address a change is refused and every filter stays", async () => {
  // 1,995 characters of owned parameters: one more value or a sort goes over the 2,000 a link carries
  const base = "status=consigned&q=";
  const search = `${base}${"x".repeat(1995 - base.length)}`;
  await withPage(search, async (page) => {
    expect(await statements(page)).toEqual(["Status ist Eingeliefert"]);
    await page.locator(".k2-stmt-b").first().click();
    await page.getByRole("option", { name: /Fotografiert/ }).click();
    await page.getByText("Dieser Wert geht als Filter nicht. Die Liste bleibt, wie sie ist.").waitFor();
    expect(new URL(page.url()).searchParams.get("status")).toBe("consigned");
    expect(await statements(page)).toEqual(["Status ist Eingeliefert"]);
    expect(await page.getByRole("option", { name: /Fotografiert/ }).getAttribute("aria-selected")).toBe("false");
    await page.keyboard.press("Escape");
    // a sort that would not fit is locked in its menu; the current one stays chosen
    await page.locator(".k2-order .k2-btn").first().click();
    expect(await page.getByRole("menuitemradio", { name: "Preis ↓" }).getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByRole("menuitemradio", { name: "Eingang ↓" }).getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).search.length).toBe(search.length + 1);
  });
});

test("a value the address cannot hold is refused at its field; nothing is written and nothing throws", async () => {
  await withPage(articles, async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const from = page.locator(".k2-fpop .k2-fed-field").first().locator("input");
    // 1e21 is a number, but the list query writes numbers without an exponent, so its URL cannot hold it
    await from.fill("1e21");
    await from.press("Enter");
    await page.getByText("Dieser Wert geht als Filter nicht. Die Liste bleibt, wie sie ist.").waitFor();
    expect(await from.getAttribute("aria-invalid")).toBe("true");
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..");
    expect(await statements(page)).toContain("Preis ab 500 €");
    // a value it can hold clears the error and applies
    await from.fill("800");
    await from.press("Enter");
    expect(new URL(page.url()).searchParams.get("price")).toBe("800..");
    expect(await page.locator(".k2-fpop .k2-fed-error").count()).toBe(0);
  });
});

test("phone: one line that scrolls sideways; a tap opens the sheet at that filter", async () => {
  await withPage(
    articles,
    async (page) => {
      const bar = page.locator(".k2-fbar");
      expect(await bar.evaluate((node) => getComputedStyle(node).overflowX)).toBe("auto");
      const rows = await page
        .locator(".k2-fbar-flow > :visible")
        .evaluateAll((nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().top))).size);
      expect(rows).toBe(1);
      expect(await page.locator(".k2-stmt-x:visible").count()).toBe(0);
      expect(await page.getByRole("button", { name: /^Filter\s*3$/ }).count()).toBe(1);
      await page.locator(".k2-fbar-item:first-child .k2-stmt-b").tap();
      const sheet = page.getByRole("dialog", { name: "Status" });
      await sheet.waitFor();
      // the sheet slides up; it stands once its animation ends
      await steady(page, '[role="dialog"]');
      await sheet.getByRole("option", { name: /Online/ }).tap();
      expect(new URL(page.url()).searchParams.get("status")).toBe("consigned,photographed,online");
      await page.getByRole("button", { name: "Zurück", exact: true }).tap();
      await page.getByRole("dialog", { name: "Filter" }).waitFor();
      expect(await page.locator(".k2-fsheet-row").first().textContent()).toContain("Eingeliefert, Fotografiert oder Online");
      expect(await page.getByRole("button", { name: /Artikel zeigen$/ }).textContent()).toBe("8 Artikel zeigen");
    },
    { width: 390, touch: true },
  );
});

test("views: “Als neue Ansicht speichern” waits for a change and saves the whole address into the chosen store", async () => {
  await withPage("", async (page) => {
    await page.getByRole("button", { name: "Ansicht" }).click();
    const save = page.getByRole("menuitem", { name: /Als neue Ansicht speichern/ });
    expect(await save.getAttribute("aria-disabled")).toBe("true");
    await page.keyboard.press("Escape");
  });
  await withPage(`${articles}&group=location`, async (page) => {
    await page.getByRole("button", { name: "Ansicht" }).click();
    await page.getByRole("menuitem", { name: /Als neue Ansicht speichern/ }).click();
    const dialog = page.getByRole("dialog", { name: "Ansicht speichern" });
    await dialog.waitFor();
    // "für alle" is named but locked: the person may not write there
    expect(await dialog.getByRole("radio", { name: /Alle/ }).isDisabled()).toBe(true);
    expect(await dialog.getByRole("radio", { name: /Nur ich/ }).isChecked()).toBe(true);
    expect(await dialog.locator(".k2-fsave-sum dd").first().textContent()).toContain("Preis ab 500 €");
    await dialog.getByRole("textbox").fill("Möbel in Arbeit");
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.__changes?.filter((change) => change.startsWith("saved")))).toEqual([
      `saved person Möbel in Arbeit ${articles.replaceAll(",", "%2C")}&group=location`,
    ]);
  });
});
