import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// A menu's width now follows its entries, which only a real layout engine
// measures, so the shipped browser build opens real menus here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "menu-width.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AutocompleteEditor, ContextMenu, Dropdown, FilterChip, Select, SelectChip, SplitButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const long = "Gutschrift des Lieferanten für die Rücksendung vom 30. September an das Lager in Konstanz";
const word = "Lieferantengutschriftsrücksendungsnummernkreisverwaltung";
const menu = (label, props) =>
  createComponent(Dropdown.Root, {
    ...props,
    get children() {
      return createComponent(Dropdown.Trigger, { size: "sm", variant: "secondary", children: label });
    },
  });
const [filter, setFilter] = createSignal([]);
const [density, setDensity] = createSignal("compact");

render(
  () => [
    menu("Short", { items: [{ label: "Rename", action: () => {} }, { label: "Archive", action: () => {} }] }),
    menu("Long", {
      items: [
        { label: long, description: "Erstellt eine Gutschrift und bucht sie gegen die offene Rechnung", action: () => {} },
        { label: word, action: () => {} },
        { label: "Archive", action: () => {} },
      ],
    }),
    menu("Exact", { width: "10rem", items: [{ label: long, action: () => {} }] }),
    menu("Touch", { variant: "touch", position: "bottom-left", items: [{ label: long, action: () => {} }] }),
    createComponent(FilterChip, {
      label: "Payment",
      icon: "ti ti-filter",
      get value() {
        return filter();
      },
      onValueChange: setFilter,
      options: [
        {
          label: "Payment",
          options: [
            { value: "debit", label: "Nur offene mit Lastschrift oder Visa" },
            { value: "margin", label: "Differenzbesteuerung § 25a" },
          ],
        },
      ],
    }),
    createComponent(SplitButton, {
      size: "sm",
      menuLabel: "More save options",
      items: [{ label: "Speichern und eine Kopie als Vorlage für alle Filialen anlegen", action: () => {} }],
      children: "Save",
    }),
    createComponent(SelectChip, {
      "aria-label": "Density",
      get value() {
        return density();
      },
      onValueChange: setDensity,
      options: [
        { value: "compact", label: "Compact" },
        { value: "comfortable", label: "Comfortable with room for the whole description" },
      ],
    }),
    createComponent(Select, {
      label: "Account",
      class: "narrow-field",
      value: "debit",
      options: [
        { value: "debit", label: "Debitorenkonto", description: "Forderungen aus Lieferungen und Leistungen gegenüber Kunden" },
        { value: "credit", label: word },
      ],
    }),
    createComponent(AutocompleteEditor, {
      label: "Formula",
      value: "",
      completions: [
        {
          trigger: "@",
          dropdown: true,
          suggest: () => [
            { text: "@record.fields.lieferantengutschrift_ruecksendung_konstanz_september", hint: "Text field" },
            { text: "@id" },
          ],
        },
      ],
    }),
    createComponent(ContextMenu, {
      label: "Note",
      items: [{ label: long, action: () => {} }, { label: "Pin", action: () => {} }],
      children: "Shopping note",
    }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the menu fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: (typeof viewports)[keyof typeof viewports]) => {
  const page = await browser.newPage(options);
  // Triggers sit at both edges, where a menu is most likely to leave the viewport.
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} .narrow-field { width: 12rem }</style></head>` +
      `<body class="k2b-ui" style="margin:0"><main id="app" style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByText("Shopping note").waitFor();
  return page;
};

/** Waits two frames: menus place themselves in a microtask or the next frame after the input that opens them. */
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

const triggerBoxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#app > *"), (element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
    }),
  );

/** The open menu's box and whether any of its labels is cut off. */
const openMenu = (page: Page) =>
  page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".k2b-dropdown__menu:popover-open, .k2b-context-menu");
    if (!menu) return undefined;
    const box = menu.getBoundingClientRect();
    const labels = Array.from(menu.querySelectorAll<HTMLElement>(".k2b-dropdown__copy > *"));
    return {
      left: box.left,
      right: box.right,
      width: Math.round(box.width),
      viewport: window.innerWidth,
      overflows: menu.scrollWidth > menu.clientWidth,
      cut: labels
        .filter((label) => label.scrollWidth > label.clientWidth || getComputedStyle(label).textOverflow === "ellipsis")
        .map((label) => label.textContent),
      lines: labels.map((label) =>
        Math.round(label.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(label).lineHeight)),
      ),
    };
  });

type Case = {
  open: (page: Page) => Promise<void>;
  /** Expected border-box width in CSS pixels per viewport, or a range. */
  width: (viewport: number) => number | [number, number];
};

const click = (name: string) => async (page: Page) => {
  await page.getByRole("button", { name, exact: true }).click();
};

const cases: Record<string, Case> = {
  // Short entries keep the former 12rem.
  "short dropdown": { open: click("Short"), width: () => 192 },
  // Long entries grow the menu up to the viewport less 1rem per side; on a
  // phone they wrap there.
  "long dropdown": { open: click("Long"), width: (viewport) => (viewport > 1000 ? [353, viewport - 33] : viewport - 32) },
  // An explicit width stays exact; its entries wrap within it.
  "dropdown with an explicit width": { open: click("Exact"), width: () => 160 },
  // Touch menus start at 18rem and grow the same way.
  "touch dropdown": { open: click("Touch"), width: (viewport) => (viewport > 1000 ? [289, viewport - 33] : viewport - 32) },
  // Wider than their former fixed widths, as wide as their longest option.
  "filter chip": { open: click("Payment"), width: () => [209, 358] },
  "split button": { open: click("More save options"), width: (viewport) => (viewport > 1000 ? [193, viewport - 33] : viewport - 32) },
  "select chip": { open: click("Density"), width: (viewport) => [161, viewport - 32] },
  "context menu": {
    open: async (page) => {
      await page.getByRole("group", { name: "Note" }).click({ button: "right" });
    },
    // A context menu keeps 0.5rem to each viewport edge.
    width: (viewport) => (viewport > 1000 ? [353, viewport - 17] : viewport - 16),
  },
};

describe("@k2b/ui menus size to their entries", () => {
  for (const options of Object.values(viewports)) {
    for (const [name, menuCase] of Object.entries(cases)) {
      test(`${name} at ${options.viewport.width} px stays inside the viewport with every label readable`, async () => {
        const page = await load(options);
        try {
          const before = await triggerBoxes(page);
          await menuCase.open(page);
          await settle(page);
          const menu = await openMenu(page);
          expect(menu).toBeDefined();
          if (!menu) return;

          const width = menuCase.width(options.viewport.width);
          if (Array.isArray(width)) {
            expect(menu.width).toBeGreaterThanOrEqual(width[0]);
            expect(menu.width).toBeLessThanOrEqual(width[1]);
          } else {
            expect(menu.width).toBe(width);
          }
          expect(menu.left).toBeGreaterThanOrEqual(8);
          expect(menu.right).toBeLessThanOrEqual(menu.viewport - 8);
          expect(menu.overflows).toBe(false);
          expect(menu.cut).toEqual([]);
          // Opening a menu moves nothing on the page.
          expect(await triggerBoxes(page)).toEqual(before);
        } finally {
          await page.close();
        }
      });
    }

    test(`at ${options.viewport.width} px completion suggestions grow to their longest entry inside the viewport`, async () => {
      const page = await load(options);
      try {
        const before = await triggerBoxes(page);
        await page.getByRole("textbox", { name: "Formula" }).pressSequentially("@");
        await page.locator(".k2b-autocomplete__options:popover-open").waitFor();
        await settle(page);
        const list = await page.evaluate(() => {
          const popover = document.querySelector<HTMLElement>(".k2b-autocomplete__options:popover-open")!;
          const box = popover.getBoundingClientRect();
          const labels = Array.from(popover.querySelectorAll<HTMLElement>(".k2b-autocomplete__option > *"));
          return {
            left: box.left,
            right: box.right,
            width: box.width,
            cut: labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
          };
        });
        // Wider than the former fixed 280px on a desktop; on a phone it fills
        // the viewport less 0.5rem per side and the long path wraps.
        if (options.viewport.width > 1000) expect(list.width).toBeGreaterThan(280);
        else expect(Math.round(list.width)).toBe(options.viewport.width - 16);
        expect(list.left).toBeGreaterThanOrEqual(8);
        expect(list.right).toBeLessThanOrEqual(options.viewport.width - 8);
        expect(list.cut).toEqual([]);
        expect(await triggerBoxes(page)).toEqual(before);
      } finally {
        await page.close();
      }
    });

    test(`at ${options.viewport.width} px a select's option list keeps the field's width and wraps long options`, async () => {
      const page = await load(options);
      try {
        const trigger = page.getByRole("combobox", { name: "Account" });
        const field = await trigger.boundingBox();
        await trigger.click();
        await page.locator(".k2b-choice-popover:popover-open").waitFor();
        await settle(page);
        const list = await page.evaluate(() => {
          const popover = document.querySelector<HTMLElement>(".k2b-choice-popover:popover-open")!;
          const box = popover.getBoundingClientRect();
          const labels = Array.from(popover.querySelectorAll<HTMLElement>(".k2b-choice-option strong, .k2b-choice-option small"));
          return {
            width: box.width,
            right: box.right,
            cut: labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
            wrapped: labels.map(
              (label) => label.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(label).lineHeight) * 1.5,
            ),
          };
        });
        expect(Math.round(list.width)).toBe(Math.round(field!.width));
        expect(list.right).toBeLessThanOrEqual(options.viewport.width - 8);
        expect(list.cut).toEqual([]);
        // The short label stays on one line; the description and the long word wrap.
        expect(list.wrapped).toEqual([false, true, true]);
      } finally {
        await page.close();
      }
    });

    test(`at ${options.viewport.width} px long entries stay on one line until the viewport ends`, async () => {
      const page = await load(options);
      try {
        await click("Long")(page);
        await settle(page);
        const lines = (await openMenu(page))?.lines ?? [];
        // Label and description of the long entry, then the long word, then
        // "Archive": one line each on a desktop, wrapped on a phone.
        const long = options.viewport.width > 1000 ? 1 : 2;
        expect(lines).toEqual([long, long, long, 1]);
      } finally {
        await page.close();
      }
    });

    test(`at ${options.viewport.width} px choosing an option keeps the menu's width`, async () => {
      const page = await load(options);
      try {
        await click("Payment")(page);
        await settle(page);
        const before = await openMenu(page);
        await page.getByRole("menuitemradio", { name: "Nur offene mit Lastschrift oder Visa" }).click();
        await settle(page);
        const after = await openMenu(page);
        expect(after?.width).toBe(before?.width);
        // The options keep their lines; a reset entry follows them.
        expect(after?.lines.slice(0, 2)).toEqual(before?.lines);
      } finally {
        await page.close();
      }
    });
  }
});
