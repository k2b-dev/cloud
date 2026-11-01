import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A searchable menu keeps the focus in its field and marks entries as the field's active descendant, and a menu can
// adopt a server-rendered link as its trigger. Both need real focus, keys, and popovers, so the shipped build runs here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dropdown-search.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Dropdown } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

globalThis.chosen = [];
const choose = (name) => () => globalThis.chosen.push(name);
const templates = ["Weekly report", "Goods receipt", "Complaint", "Inventory", "Route plan", "Check invoice", "Forklift service", "Order labels"];
const items = [
  { label: "Blank task", icon: "ti ti-plus", variant: "accent", action: choose("blank") },
  { sectionLabel: "Templates", items: templates.map((name) => ({ label: name, icon: "ti ti-file", description: name === "Complaint" ? "+2 days · High" : undefined, action: choose(name) })) },
  { label: "Create template…", icon: "ti ti-template", action: choose("create") },
];

render(
  () => [
    createComponent(Dropdown.Root, {
      items,
      label: "New task",
      icons: "tile",
      search: {
        label: "Find template",
        filter: (query) => [
          { sectionLabel: "Templates", items: templates.filter((name) => name.toLowerCase().includes(query.toLowerCase())).map((name) => ({ label: name, action: choose(name) })) },
          { label: "Blank task “" + query + "”", action: choose("blank:" + query) },
        ].filter((item) => !("items" in item) || item.items.length),
        status: (query, matches) => matches - 1 + " templates match",
      },
      get children() {
        return createComponent(Dropdown.Trigger, { variant: "secondary", children: "Search menu" });
      },
    }),
    createComponent(Dropdown.Root, {
      items: [{ label: "Alpha", action: choose("alpha") }, { sectionLabel: "More", items: [{ label: "Beta", description: "second", action: choose("beta") }] }],
      label: "Default filter",
      search: { label: "Filter" },
      get children() {
        return createComponent(Dropdown.Trigger, { variant: "secondary", children: "Default search" });
      },
    }),
    createComponent(Dropdown.Root, {
      items,
      label: "Sheet menu",
      phone: "sheet",
      icons: "tile",
      search: { label: "Find template" },
      get children() {
        return createComponent(Dropdown.Trigger, { variant: "secondary", children: "Sheet menu" });
      },
    }),
    createComponent(Dropdown.Root, {
      items: [{ label: "Blank task", action: choose("link-blank") }, { label: "Weekly report", action: choose("link-weekly") }],
      label: "New task",
      attach: () => document.getElementById("server-link"),
    }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dropdown search fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: Parameters<Browser["newPage"]>[0] = { viewport: { width: 1280, height: 800 } }) => {
  const page = await browser.newPage(options);
  // A real address, not about:blank: a phone sheet closes through history, which WebKit does not traverse there.
  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-wrap:wrap;gap:12px;padding:16px">` +
    `<a id="server-link" class="k2b-button" href="#compose" aria-haspopup="menu">New task</a><div id="app" style="display:contents"></div></main></body></html>`;
  await page.route("http://dropdown.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://dropdown.test/");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Search menu" }).waitFor();
  return page;
};

/** The focused element's role and the label of the entry it marks as active. */
const state = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    const activeId = focused?.getAttribute("aria-activedescendant");
    const active = activeId ? document.getElementById(activeId) : null;
    return {
      role: focused?.getAttribute("role") ?? null,
      active: active?.querySelector(".k2b-dropdown__copy > span")?.textContent ?? null,
      selected: active?.getAttribute("aria-selected") ?? null,
      status: document.querySelector(".k2b-dropdown__menu:popover-open [role='status']")?.textContent ?? null,
    };
  });

const chosen = (page: Page) => page.evaluate(() => (globalThis as unknown as { chosen: string[] }).chosen);

describe("Dropdown search", () => {
  test("Enter opens with the first entry marked, and Enter again chooses it", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Search menu" }).focus();
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await page.getByRole("dialog", { name: "New task" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Search menu" }).getAttribute("aria-haspopup")).toBe("dialog");
      expect(await state(page)).toMatchObject({ role: "combobox", active: "Blank task", selected: "true" });
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await chosen(page)).toEqual(["blank"]);
      expect(await page.getByRole("dialog", { name: "New task" }).isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("arrows move the mark, typing filters and announces, Escape closes and returns focus", async () => {
    const page = await load();
    try {
      const trigger = page.getByRole("button", { name: "Search menu" });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await settled(page);
      await page.keyboard.press("ArrowDown");
      expect((await state(page)).active).toBe("Weekly report");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      expect((await state(page)).active).toBe("Create template…");

      await page.keyboard.type("com");
      await settled(page);
      expect(await state(page)).toMatchObject({ role: "combobox", active: "Complaint", status: "1 templates match" });
      expect(await page.getByRole("option").allTextContents()).toEqual(["Complaint", "Blank task “com”"]);
      await page.keyboard.press("ArrowDown");
      expect((await state(page)).active).toBe("Blank task “com”");

      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog", { name: "New task" }).isVisible()).toBe(false);
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      // Reopening starts without the old query.
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await page.getByRole("combobox", { name: "Find template" }).inputValue()).toBe("");
      expect(await page.getByRole("option").count()).toBe(10);
    } finally {
      await page.close();
    }
  });

  test("a query without a host filter keeps the matching entries in their sections", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Default search" }).click();
      await settled(page);
      await page.keyboard.type("sec");
      await settled(page);
      expect(await page.getByRole("option").allTextContents()).toEqual(["Betasecond"]);
      expect((await state(page)).status).toBe("1 match");
      await page.keyboard.type("zzz");
      await settled(page);
      expect(await page.getByText("No results").isVisible()).toBe(true);
      expect((await state(page)).status).toBe("0 matches");
    } finally {
      await page.close();
    }
  });

  test("pointer movement marks the entry under it, and a click chooses it", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Search menu" }).click();
      await settled(page);
      await page.getByRole("option", { name: "Inventory" }).hover();
      expect((await state(page)).active).toBe("Inventory");
      await page.getByRole("option", { name: "Inventory" }).click();
      expect(await chosen(page)).toEqual(["Inventory"]);
    } finally {
      await page.close();
    }
  });

  test("the field stays in place while the entries scroll, and opening moves nothing on the page", async () => {
    const page = await load({ viewport: { width: 1280, height: 360 } });
    try {
      const before = await page.getByRole("button", { name: "Search menu" }).boundingBox();
      await page.getByRole("button", { name: "Search menu" }).click();
      await settled(page);
      const field = await page.getByRole("combobox").boundingBox();
      for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowDown");
      await settled(page);
      expect(await page.getByRole("combobox").boundingBox()).toEqual(field);
      expect(await page.getByRole("option", { name: "Create template…" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Search menu" }).boundingBox()).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("a phone opens the same search in a sheet with the focus in its field", async () => {
    const page = await load({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await page.getByRole("button", { name: "Sheet menu" }).tap();
      const sheet = page.getByRole("dialog", { name: "Sheet menu" }).last();
      await sheet.waitFor();
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("combobox");
      expect((await state(page)).active).toBe("Blank task");
      await page.keyboard.type("route");
      await settled(page);
      expect(await page.getByRole("option").allTextContents()).toEqual(["Route plan"]);
      await page.getByRole("option", { name: "Route plan" }).tap();
      await page.waitForFunction(() => (globalThis as unknown as { chosen: string[] }).chosen.length > 0);
      expect(await chosen(page)).toEqual(["Route plan"]);
    } finally {
      await page.close();
    }
  });
});

describe("Dropdown attach", () => {
  test("a plain click on the adopted link opens the menu, a modified click keeps the link", async () => {
    const page = await load();
    try {
      const link = page.locator("#server-link");
      expect(await link.getAttribute("aria-expanded")).toBe("false");
      expect(await link.getAttribute("aria-controls")).toMatch(/^k2b-dropdown-/);
      await link.click();
      await settled(page);
      expect(await page.getByRole("menu", { name: "New task" }).isVisible()).toBe(true);
      expect(await link.getAttribute("aria-expanded")).toBe("true");
      expect(page.url()).not.toContain("#compose");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await link.getAttribute("aria-expanded")).toBe("false");

      // A modified click is the browser's: the host's own handler would see it unprevented.
      const prevented = await link.evaluate((element) => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
        element.addEventListener("click", (click) => click.preventDefault(), { once: true });
        const result = { before: false };
        element.addEventListener(
          "click",
          (click) => {
            result.before = click.defaultPrevented;
          },
          { once: true, capture: true },
        );
        element.dispatchEvent(event);
        return result.before;
      });
      expect(prevented).toBe(false);
      expect(await page.getByRole("menu", { name: "New task" }).isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("Enter, Space, and Down on the link open the menu with the first entry focused; Enter chooses it", async () => {
    const page = await load();
    try {
      const link = page.locator("#server-link");
      for (const key of ["Enter", " ", "ArrowDown"]) {
        await link.focus();
        await page.keyboard.press(key);
        await settled(page);
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Blank task");
        await page.keyboard.press("Escape");
        await settled(page);
      }
      await link.focus();
      await page.keyboard.press("Enter");
      await settled(page);
      await page.keyboard.press("Enter");
      expect(await chosen(page)).toEqual(["link-blank"]);
      expect(page.url()).not.toContain("#compose");
    } finally {
      await page.close();
    }
  });
});
