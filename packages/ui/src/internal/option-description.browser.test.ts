import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

// An option can show a visual, such as a colored tag, in place of its second
// line (#3282). Every option list draws it the same way: the row keeps its
// height, and search, keys, and what a screen reader hears stay those of the
// text. Rows A and B carry the same description; only A has the visual.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "option-description.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AutocompleteSelect, ChoiceList, Combobox, Dropdown, MultiSelectInput, RichSelect, Select, Tag, prompts } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

globalThis.chosen = [];
const ebay = () => createComponent(Tag, { color: "#e53238", size: "sm", children: "eBay" });
const rows = [
  { value: "a", label: "Anna Berger (A)", description: "eBay", descriptionVisual: ebay },
  { value: "b", label: "Anna Berger (B)", description: "eBay" },
  { value: "c", label: "Carla Weiss (C)", description: "Shop" },
];
// The host rebuilds equal entries with fresh closures, as an editor does while its table actions come and go.
const menuItems = () => rows.map((row) => ({ label: row.label, description: row.description, descriptionVisual: row.descriptionVisual && (() => ebay()), action: () => globalThis.chosen.push("menu:" + row.value) }));
const [menu, setMenu] = createSignal(menuItems());
globalThis.rebuildMenu = () => setMenu(menuItems());
const matching = (query) => rows.filter((row) => (row.label + " " + row.description).toLowerCase().includes(query.toLowerCase()));

globalThis.openSearch = () =>
  void prompts.search(({ query }) => matching(query).map((row) => ({ id: row.value, label: row.label, desc: row.description, descriptionVisual: row.descriptionVisual })), { title: "Find customer" });

render(
  () => [
    createComponent(Select, { label: "Customer", options: rows, searchable: true, value: null, onValueChange: (value) => globalThis.chosen.push(value) }),
    createComponent(AutocompleteSelect, { label: "Customer lookup", value: null, search: (query) => Promise.resolve({ options: matching(query) }), debounceMs: 0 }),
    createComponent(Combobox, { label: "Customer search", debounceMs: 0, fetchData: (query) => Promise.resolve(matching(query).map((row) => ({ ...row, id: row.value }))), onSelect: () => {} }),
    createComponent(MultiSelectInput, { label: "Customers", options: rows, value: [] }),
    createComponent(RichSelect, { label: "Customer card", title: "Customer card", items: rows, value: null }),
    createComponent(ChoiceList, { label: "Customer kind", options: rows, value: null }),
    createComponent(Dropdown.Root, {
      label: "Customer menu",
      phone: "sheet",
      search: { label: "Filter customers" },
      get items() {
        return menu();
      },
      get children() {
        return createComponent(Dropdown.Trigger, { variant: "secondary", children: "Customer menu" });
      },
    }),
  ],
  document.getElementById("host"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the option description fixture for the browser.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    chosen: string[];
    openSearch: () => void;
    rebuildMenu: () => void;
  }
}

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Theme = "light" | "dark";

const open = async (theme: Theme, width = 1024) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
        `<style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
        `<body class="k2b-ui" data-theme="${theme}"><div id="host" style="width: 320px; padding: 16px; display: grid; gap: 12px"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    return { page, errors };
  } catch (error) {
    await page.close();
    throw error;
  }
};

/** Opens one list and returns rows A and B. */
type Opener = (page: Page) => Promise<{ a: Locator; b: Locator }>;

const rowsByRole = (page: Page, role: "option" | "radio" | "button") => ({
  a: page.getByRole(role, { name: /Anna Berger \(A\)/ }),
  b: page.getByRole(role, { name: /Anna Berger \(B\)/ }),
});

const lists: Record<string, Opener> = {
  Select: async (page) => {
    await page.getByRole("combobox", { name: "Customer", exact: true }).click();
    return rowsByRole(page, "option");
  },
  AutocompleteSelect: async (page) => {
    await page.getByRole("combobox", { name: "Customer lookup" }).fill("Anna");
    return rowsByRole(page, "option");
  },
  Combobox: async (page) => {
    await page.getByRole("combobox", { name: "Customer search" }).fill("Anna");
    return rowsByRole(page, "option");
  },
  MultiSelectInput: async (page) => {
    await page.getByRole("combobox", { name: "Customers" }).click();
    return rowsByRole(page, "option");
  },
  RichSelect: async (page) => {
    await page.getByRole("combobox", { name: "Customer card" }).click();
    return rowsByRole(page, "option");
  },
  ChoiceList: async (page) => rowsByRole(page, "radio"),
  // A menu with a search field lists its entries as options of that field.
  Dropdown: async (page) => {
    await page.getByRole("button", { name: "Customer menu" }).click();
    return rowsByRole(page, "option");
  },
  "prompts.search": async (page) => {
    await page.evaluate(() => window.openSearch());
    await page.getByRole("combobox", { name: "Find customer" }).fill("Anna");
    return rowsByRole(page, "option");
  },
};

const expectSameRows = async ({ a, b }: { a: Locator; b: Locator }) => {
  await a.waitFor();
  await b.waitFor();
  // A phone sheet slides in; measure where it rests.
  await settled(a.page());
  const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()];
  // The visual takes the height of the text line it replaces, up to layout rounding.
  expect(boxA!.height).toBeCloseTo(boxB!.height, 1);

  const visual = a.locator(".k2b-option-visual");
  expect(await visual.isVisible()).toBe(true);
  expect(await visual.getAttribute("aria-hidden")).toBe("true");
  // The tag is colored, not a grey word.
  const tag = visual.locator(".k2b-tag");
  expect(await tag.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  // The tag stays inside its row.
  const [row, tagBox] = [await a.boundingBox(), await tag.boundingBox()];
  expect(tagBox!.y).toBeGreaterThanOrEqual(row!.y);
  expect(tagBox!.y + tagBox!.height).toBeLessThanOrEqual(row!.y + row!.height);

  // A screen reader hears the same row with or without the visual. A search
  // list marks its first row active, which is not part of the comparison.
  const spoken = async (row: Locator) => (await row.ariaSnapshot()).replace(" [selected]", "");
  expect((await spoken(a)).replaceAll("(A)", "(B)")).toBe(await spoken(b));
};

describe("@k2b/ui option lists with a visual in place of the description", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, openList] of Object.entries(lists)) {
      test(`${name} (${theme}): the visual row is as tall as the text row and reads the same`, async () => {
        const { page, errors } = await open(theme);
        try {
          await expectSameRows(await openList(page));
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
    }
  }

  test("Select finds the visual option by its description and picks it with the keys", async () => {
    const { page, errors } = await open("light");
    try {
      await page.getByRole("combobox", { name: "Customer", exact: true }).click();
      await page.getByRole("searchbox").fill("ebay");
      await settled(page);
      const found = page.getByRole("option");
      expect(await found.count()).toBe(2);
      expect(await found.first().getAttribute("aria-label")).toBe("Anna Berger (A)");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.chosen)).toEqual(["a"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("Dropdown search finds the visual entry by its description and runs it with the keys", async () => {
    const { page, errors } = await open("light");
    try {
      await page.getByRole("button", { name: "Customer menu" }).click();
      await page.getByRole("combobox", { name: "Filter customers" }).fill("ebay");
      await settled(page);
      expect(await page.getByRole("option").count()).toBe(2);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.chosen)).toEqual(["menu:a"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("Dropdown keeps each second line in place while its host rebuilds equal entries", async () => {
    const { page, errors } = await open("light");
    try {
      const { a } = await lists.Dropdown!(page);
      await a.waitFor();
      const lines = page.locator(".k2b-dropdown__copy > small");
      const count = await lines.count();
      expect(count).toBe(3);
      await lines.evaluateAll((elements) => elements.forEach((element) => element.setAttribute("data-before", "")));
      await page.evaluate(() => window.rebuildMenu());
      await settled(page);
      // The same elements remain: nothing outside the changed text is replaced.
      expect(await page.locator(".k2b-dropdown__copy > small[data-before]").count()).toBe(count);
      expect(await a.locator(".k2b-option-visual .k2b-tag").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  const sheets: Record<string, Opener> = {
    Dropdown: lists.Dropdown!,
    // The phone sheet lists its rows as buttons.
    RichSelect: async (page) => {
      await page.getByRole("combobox", { name: "Customer card" }).click();
      return rowsByRole(page, "button");
    },
  };
  for (const [name, openSheet] of Object.entries(sheets)) {
    test(`${name} on a phone: the sheet rows keep one height with the visual`, async () => {
      const { page, errors } = await open("light", 390);
      try {
        await expectSameRows(await openSheet(page));
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
