import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
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

const withPage = async (
  search: string,
  run: (page: Page) => Promise<void>,
  { width = 1440, touch = false, timezoneId }: { width?: number; touch?: boolean; timezoneId?: string } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch, timezoneId });
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

/** Opens "Ab …" or "Bis …" of the open range editor beside it and gives its number field. */
const boundField = async (page: Page, bound: RegExp) => {
  await page.locator(".k2-fpop .k2-fed-bounds .k2-mi", { hasText: bound }).click();
  const field = page.locator(".k2-dpop .k2-nentry input");
  await field.waitFor();
  return field;
};
const statements = (page: Page) => page.locator(".k2-fbar-flow .k2-stmt-b").allTextContents();
const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`no box for ${selector}`);
  return found;
};
/** Waits until the element keeps its place for two frames, such as a sheet once it has slid up. */
const steady = async (page: Page, selector: string) => {
  // each wait measures afresh: a top kept from an earlier wait would match the one frame in which a sheet whose content
  // just changed still stands at its old place
  await page.evaluate((s) => document.querySelector(s)?.removeAttribute("data-test-top"), selector);
  await page.waitForFunction(
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
};
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
    await hoverInPlace(page.locator(".k2-fbar-item:first-child .k2-stmt"));
    await settled(page);
    expect(await box(page, ".k2-fbar-item:first-child .k2-stmt")).toEqual(before);
    await page.keyboard.press("Tab");
    await page.locator(".k2-fbar-item:first-child .k2-stmt-b").focus();
    await settled(page);
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

test("lookup: typing waits, a newer search aborts the one that runs, Escape empties the search, then closes", async () => {
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    await page.getByRole("combobox", { name: "Einlieferer suchen" }).waitFor();
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
    // Escape first empties the search (core's command steps back one thing at a time), which aborts the load that
    // runs; the next Escape closes the editor
    await page.keyboard.type("x");
    await page.waitForTimeout(260);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("combobox", { name: "Einlieferer suchen" }).inputValue()).toBe("");
    expect((await calls(page)).find((call) => call.query === "bergx")?.aborted).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator(".k2-fpop").waitFor({ state: "detached" });
  });
});

test("lookup: a failed load says so, keeps the choice, and “Erneut versuchen” loads again", async () => {
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    await page.getByRole("combobox", { name: "Einlieferer suchen" }).waitFor();
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
    await page.getByRole("menuitemradio", { name: "Preis" }).click();
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
    expect(await page.locator(".k2-order .k2-btn").first().textContent()).toContain("Preis · Höchster zuerst");
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
    // the range: "Bis …" opens a number entry beside the editor; below "Ab" is refused with a sentence; Enter applies
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const to = await boundField(page, /^Bis/);
    // no spinner: a text field with the decimal keyboard
    expect(await to.getAttribute("type")).toBe("text");
    expect(await to.getAttribute("inputmode")).toBe("decimal");
    await to.fill("300");
    await to.press("Enter");
    await page.getByText("„Ab“ ist größer als „Bis“. Der Filter gilt so nicht.").waitFor();
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..");
    // German marks: "2.000" is two thousand
    await to.fill("2.000");
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
    // a value that would not fit is locked where it is offered; pressing it changes nothing
    expect(await page.getByRole("option", { name: /Fotografiert/ }).getAttribute("aria-disabled")).toBe("true");
    await page.getByRole("option", { name: /Fotografiert/ }).click({ force: true });
    expect(new URL(page.url()).searchParams.get("status")).toBe("consigned");
    expect(await statements(page)).toEqual(["Status ist Eingeliefert"]);
    expect(await page.getByRole("option", { name: /Fotografiert/ }).getAttribute("aria-selected")).toBe("false");
    await page.keyboard.press("Escape");
    // a sort that would not fit is locked in its menu; the current one stays chosen
    await page.locator(".k2-order .k2-btn").first().click();
    expect(await page.getByRole("menuitemradio", { name: "Preis" }).getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByRole("menuitemradio", { name: "Eingang" }).getAttribute("aria-checked")).toBe("true");
    expect(await page.getByRole("menuitemradio", { name: "Älteste zuerst" }).getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByRole("menuitemradio", { name: "Neueste zuerst" }).getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).search.length).toBe(search.length + 1);
  });
});

test("a value the address cannot hold is refused at its field; nothing is written and nothing throws", async () => {
  await withPage(articles, async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const from = await boundField(page, /^Ab/);
    // 10^21 is a number, but the list query writes numbers without an exponent, so its URL cannot hold it
    await from.fill("1000000000000000000000");
    await from.press("Enter");
    await page.getByText("Dieser Wert geht als Filter nicht. Die Liste bleibt, wie sie ist.").waitFor();
    expect(await from.getAttribute("aria-invalid")).toBe("true");
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..");
    expect(await statements(page)).toContain("Preis ab 500 €");
    // a value it can hold applies and closes the entry
    await from.fill("800");
    await from.press("Enter");
    expect(new URL(page.url()).searchParams.get("price")).toBe("800..");
    await page.locator(".k2-dpop").waitFor({ state: "detached" });
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
      `saved person Möbel in Arbeit ${articles}&group=location`,
    ]);
  });
});

// ── Review findings of #4136: each test failed before its fix ──────────────────────────────────────────────────

test("a lookup code nobody can name is asked for once, and stays a code with a warning", async () => {
  await withPage("consignor=c-9999", async (page) => {
    await page.waitForFunction(() => (window.__resolves ?? []).length > 0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__resolves)).toEqual([["c-9999"]]);
    expect(await statements(page)).toEqual(["Einlieferer ist c-9999"]);
    expect(await page.locator(".k2-stmt-b b .k2-icon").getAttribute("aria-label")).toBe(
      "Name nicht gefunden. Der Eintrag wurde vielleicht gelöscht.",
    );
  });
});

test("a number the field cannot read keeps the active filter and says so at the field", async () => {
  await withPage(articles, async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const from = await boundField(page, /^Ab/);
    await from.fill("");
    await from.pressSequentially("1e");
    await from.press("Enter");
    await page.getByText("Das ist keine Zahl.").waitFor();
    expect(await from.getAttribute("aria-invalid")).toBe("true");
    expect(new URL(page.url()).searchParams.get("price")).toBe("500..");
    expect(await statements(page)).toContain("Preis ab 500 €");
  });
});

// #4153: a focus move that came late took the focus from a field the person had already put it in; the emptied field
// then applied "no range" on blur, the filter and its editor went away under the typing.
test("an editor takes the focus once, in its values, and never moves it again", async () => {
  await withPage(articles, async (page) => {
    await page.evaluate(() => {
      window.__focus = [];
      document.addEventListener("focusin", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement) window.__focus?.push(target.textContent?.trim() || target.tagName);
      });
    });
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    await page.locator(".k2-fpop").waitFor();
    await page.waitForFunction(() => (window.__focus ?? []).length > 1);
    // the statement's button, then straight the first control of the values (the first preset); never "Entfernen"
    expect(await page.evaluate(() => window.__focus)).toEqual(["Preis ab 500 €", "bis 500 €"]);
    const from = await boundField(page, /^Ab/);
    await from.focus();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.matches(".k2-dpop .k2-nentry input"))).toBe(true);
  });
});

test("emptying every bound in an open editor keeps the editor: the filter waits as a dashed draft", async () => {
  await withPage(articles, async (page) => {
    await page.getByRole("button", { name: "Filter Preis ab 500 € bearbeiten" }).click();
    const from = await boundField(page, /^Ab/);
    await from.fill("");
    await from.press("Enter");
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("price"));
    expect(await page.locator(".k2-fpop").count()).toBe(1);
    expect(await page.locator(".k2-stmt[data-draft] .k2-stmt-b").textContent()).toBe("Preis …");
    // the editor is still open for the next bound
    const again = await boundField(page, /^Ab/);
    await again.fill("800");
    await again.press("Enter");
    expect(new URL(page.url()).searchParams.get("price")).toBe("800..");
    expect(await statements(page)).toContain("Preis ab 800 €");
  });
});

test("renaming a saved view keeps the query it holds, also while the list shows a changed state", async () => {
  await withPage("view=person-1&status=consigned&category=furniture&price=2000..", async (page) => {
    await page.getByRole("button", { name: "Ansicht" }).click();
    await page.getByRole("menuitem", { name: /„Teure Möbel“ umbenennen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Ansicht umbenennen" });
    await dialog.getByRole("textbox").fill("Teure Stücke");
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.__changes?.filter((change) => change.startsWith("saved")))).toEqual([
      "saved person Teure Stücke category=furniture&price=2000..",
    ]);
  });
});

test("two lookup fields with the same code keep their own names", async () => {
  await withPage("consignor=c-1001&buyer=c-1001", async (page) => {
    await page.waitForFunction(() => document.querySelectorAll(".k2-stmt-b b .k2-icon").length === 0);
    expect(await statements(page)).toEqual(["Einlieferer ist Haus Bergmann", "Käufer ist Lena Hof"]);
  });
});

/** On the phone: opens the filter sheet with its button and waits until it stands. */
const openSheet = async (page: Page) => {
  await page.getByRole("button", { name: /^Filter\s*\d*$/ }).tap();
  await page.getByRole("dialog", { name: "Filter" }).waitFor();
  await steady(page, '[role="dialog"]');
};

test("phone: each sheet session is one history entry, so Back returns to the state of the session before", async () => {
  await withPage(
    articles,
    async (page) => {
      const session = async (value: RegExp) => {
        await openSheet(page);
        await page.locator(".k2-fsheet-row").first().tap();
        await steady(page, '[role="dialog"]');
        await page.getByRole("option", { name: value }).tap();
        await page.getByRole("button", { name: /Artikel zeigen$/ }).tap();
        await page.getByRole("dialog").waitFor({ state: "detached" });
      };
      await session(/Online/);
      expect(new URL(page.url()).searchParams.get("status")).toBe("consigned,photographed,online");
      await session(/Reserviert/);
      expect(new URL(page.url()).searchParams.get("status")).toBe("consigned,photographed,online,reserved");
      await page.goBack();
      await page.waitForFunction(() => new URL(location.href).searchParams.get("status") === "consigned,photographed,online");
      expect((await statements(page))[0]).toBe("Status ist Eingeliefert, Fotografiert oder Online");
    },
    { width: 390, touch: true },
  );
});

test("phone: a range editor follows a reset, so a new end never brings back the old one", async () => {
  await withPage(
    "price=500..2000",
    async (page) => {
      await page.getByRole("button", { name: "Filter Preis 500 € bis 2.000 € bearbeiten" }).tap();
      await page.getByRole("dialog", { name: "Preis" }).waitFor();
      await steady(page, '[role="dialog"]');
      await page.getByRole("button", { name: "Zurücksetzen" }).tap();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("price"));
      // "Bis …" is the sheet's next step, with the way back in the sheet's head
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi", { hasText: /^Bis/ }).tap();
      await page.getByRole("dialog", { name: "Preis · Bis" }).waitFor();
      const field = page.locator(".k2-fsheet .k2-nentry input");
      expect(await field.inputValue()).toBe("");
      await field.fill("3000");
      await page.getByRole("button", { name: "Anwenden" }).tap();
      await page.waitForFunction(() => new URL(location.href).searchParams.get("price") === "..3000");
      await page.getByRole("dialog", { name: "Preis" }).waitFor();
    },
    { width: 390, touch: true },
  );
});

test("at the length limit, presets and sorts that would not fit are locked where they are offered", async () => {
  const base = "status=consigned&q=";
  const search = `${base}${"x".repeat(1995 - base.length)}`;
  await withPage(search, async (page) => {
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: /Eingang/ }).click();
    await page.locator(".k2-fpop [role=option]").first().waitFor();
    expect(await page.getByRole("option", { name: "letzte 7 Tage" }).getAttribute("aria-disabled")).toBe("true");
  });
  await withPage(
    search,
    async (page) => {
      await openSheet(page);
      await page.locator(".k2-fsheet-row", { hasText: "Sortierung" }).tap();
      await steady(page, '[role="dialog"]');
      expect(await page.getByRole("option", { name: "Preis" }).getAttribute("aria-disabled")).toBe("true");
      expect(await page.getByRole("option", { name: "Älteste zuerst" }).getAttribute("aria-disabled")).toBe("true");
    },
    { width: 390, touch: true },
  );
});

test("phone: “Keine Gruppen” in the sheet takes the grouping away", async () => {
  await withPage(
    "status=consigned&group=status",
    async (page) => {
      await openSheet(page);
      await page.locator(".k2-fsheet-row", { hasText: "Gruppierung" }).tap();
      await steady(page, '[role="dialog"]');
      await page.getByRole("option", { name: "Keine Gruppen" }).tap();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("group"));
    },
    { width: 390, touch: true },
  );
});

test("a view that fails to update says so and offers to try again", async () => {
  await withPage("view=person-1&status=consigned&category=furniture&price=2000..", async (page) => {
    await page.evaluate(() => {
      window.__failStore = true;
    });
    await page.getByRole("button", { name: "Ansicht" }).click();
    await page.getByRole("menuitem", { name: /„Teure Möbel“ aktualisieren/ }).click();
    await page.getByText("Ansicht nicht gespeichert").waitFor();
    await page.evaluate(() => {
      window.__failStore = false;
    });
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.waitForFunction(() => (window.__changes ?? []).some((change) => change.startsWith("saved person Teure Möbel")));
  });
});

test("points in time read in the app's time zone, the same on the server and in any browser", async () => {
  const seen = "seen=2026-11-24T08:00Z..2026-11-24T09:30Z";
  // without a zone the bar reads UTC, as the server does, even in a browser in Berlin
  await withPage(
    seen,
    async (page) => {
      expect(await statements(page)).toEqual(["Gesehen 24.11., 08:00 bis 24.11., 09:30"]);
    },
    { timezoneId: "Europe/Berlin" },
  );
  await withPage(
    `${seen}&_tz=Europe/Berlin`,
    async (page) => {
      expect(await statements(page)).toEqual(["Gesehen 24.11., 09:00 bis 24.11., 10:30"]);
    },
    { timezoneId: "America/New_York" },
  );
});

test("lookup: the focus stays in the search; the arrows move the highlight and Enter ticks it", async () => {
  await withPage("consignor=c-1005", async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    const search = page.getByRole("combobox", { name: "Einlieferer suchen" });
    await search.waitFor();
    await page.evaluate(() => window.__lookup?.answer());
    await page.getByRole("option", { name: /Haus Bergmann/ }).waitFor();
    const highlighted = () =>
      page.evaluate(() => {
        const id = document.activeElement?.getAttribute("aria-activedescendant");
        return id ? (document.getElementById(id)?.textContent ?? "") : "";
      });
    await page.keyboard.press("ArrowDown");
    expect(await highlighted()).toContain("Nachlass Kessler");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted()).toContain("Haus Bergmann");
    await page.keyboard.press("ArrowUp");
    expect(await highlighted()).toContain("Nachlass Kessler");
    // the search keeps the focus all along, so typing goes on
    expect(await search.evaluate((input) => input === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => new URL(location.href).searchParams.get("consignor") === "c-1005,c-1001");
    expect(await page.getByRole("option", { name: /Haus Bergmann/ }).getAttribute("aria-checked")).toBe("true");
  });
});

// ── Delta review of #4136 (a400358): each test failed before its fix ───────────────────────────────────────────

/**
 * Opens the calendar of "Von" (0) or "Bis" (1) of the open editor with the keys of a submenu. Keys, not clicks: in
 * WebKit each pointer action right after a popover opened or closed waits up to 1.7 s for Playwright's stable check.
 */
const openBound = async (page: Page, index: number) => {
  await page.locator(".k2-fpop .k2-fed-bounds .k2-mi").nth(index).focus();
  await page.keyboard.press("ArrowRight");
  await page.locator(".k2-dpop").waitFor();
};

test("daylight saving: both bounds applied unchanged keep their instants, also a wall time that comes twice", async () => {
  // 00:30Z is 02:30 summer time in Berlin; 02:30 comes twice that night. 03:00Z is 04:00 winter time.
  const seen = "seen=2026-10-25T00:30Z..2026-10-25T03:00Z";
  await withPage(`${seen}&_tz=Europe/Berlin`, async (page) => {
    await page.getByRole("button", { name: /^Filter Gesehen .* bearbeiten$/ }).click();
    expect(await page.locator(".k2-fpop .k2-fed-bounds .k2-mi").allTextContents()).toEqual(["Von25.10., 02:30", "Bis25.10., 04:00"]);
    const cascade = page.locator(".k2-dpop");
    const time = cascade.getByRole("textbox", { name: "Uhrzeit" });
    for (const index of [1, 0]) {
      await openBound(page, index);
      expect(await time.inputValue()).toBe(index === 0 ? "02:30" : "04:00");
      await time.press("Enter");
      await cascade.waitFor({ state: "detached" });
      expect(new URL(page.url()).searchParams.get("seen")).toBe("2026-10-25T00:30Z..2026-10-25T03:00Z");
    }
  });
});

test("daylight saving: a wall time the clocks jump over is refused at its calendar", async () => {
  // 00:30Z is 01:30 winter time in Berlin on 29 March 2026; at 02:00 the clocks jump to 03:00, so 02:30 does not exist
  const seen = "seen=2026-03-29T00:30Z..2026-03-29T03:00Z";
  await withPage(`${seen}&_tz=Europe/Berlin`, async (page) => {
    await page.getByRole("button", { name: /^Filter Gesehen .* bearbeiten$/ }).click();
    await openBound(page, 0);
    const time = page.locator(".k2-dpop").getByRole("textbox", { name: "Uhrzeit" });
    expect(await time.inputValue()).toBe("01:30");
    await time.fill("02:30");
    await time.press("Enter");
    await page.locator(".k2-dpop").getByText("Diese Uhrzeit gibt es an diesem Tag nicht (Zeitumstellung).").waitFor();
    expect(new URL(page.url()).searchParams.get("seen")).toBe(seen.slice(5));
  });
}, 15_000);

test("retrying a failed view update writes exactly what failed, not what the list shows by then", async () => {
  await withPage("view=person-1&status=consigned&category=furniture&price=2000..", async (page) => {
    await page.evaluate(() => {
      window.__failStore = true;
    });
    await page.getByRole("button", { name: "Ansicht" }).click();
    await page.getByRole("menuitem", { name: /„Teure Möbel“ aktualisieren/ }).click();
    await page.getByText("Ansicht nicht gespeichert").waitFor();
    // the list moves on before the retry
    await page.getByRole("button", { name: "Filter Status entfernen" }).click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("status"));
    await page.evaluate(() => {
      window.__failStore = false;
    });
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.waitForFunction(() => (window.__changes ?? []).some((change) => change.startsWith("saved")));
    expect(await page.evaluate(() => window.__changes?.filter((change) => change.startsWith("saved")))).toEqual([
      "saved person Teure Möbel status=consigned&category=furniture&price=2000..",
    ]);
  });
});

test("options locked by the full address say why and what to do, visibly and to assistive technology", async () => {
  const base = "status=consigned&q=";
  const search = `${base}${"x".repeat(1995 - base.length)}`;
  await withPage(search, async (page) => {
    await page.locator(".k2-stmt-b").first().click();
    const hint = page.getByText("Die Adresse ist voll. Entferne einen Filter oder kürze die Suche, um mehr zu wählen.");
    await hint.waitFor();
    const id = (await hint.getAttribute("id")) ?? "";
    expect(id).toBeTruthy();
    const option = page.getByRole("option", { name: /Fotografiert/ });
    expect(await option.getAttribute("aria-disabled")).toBe("true");
    expect((await option.getAttribute("aria-describedby"))?.split(" ")).toContain(id);
  });
});
