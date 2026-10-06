import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Fields with a description subgrid their rows. Only a real layout engine
// shows whether a field keeps its control inside when its parent is not a grid,
// as in a form dialog, so the shipped browser build renders real fields here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "field-subgrid.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { prompts, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const description = "Paste the lines exported from the payroll system, one entry per line.";
const notes = () => createComponent(TextInput, { label: "Notes", description, multiline: true, lines: 3, value: "" });

// Outside any field group: the paragraph beside it keeps the field stacked.
render(notes, document.getElementById("stacked"));
render(
  () => [
    createComponent(TextInput, {
      label: "Address",
      description: "Street and house number as printed on the delivery note for the warehouse.",
      value: "",
    }),
    createComponent(TextInput, { label: "Comment", multiline: true, lines: 3, value: "" }),
  ],
  document.getElementById("row"),
);
globalThis.openForm = () =>
  prompts.form({
    title: "Insert payroll journal",
    fields: { journal: { type: "text", label: "Notes", description, multiline: true, lines: 3 } },
  });
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the field fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: (typeof viewports)[keyof typeof viewports]) => {
  const page = await browser.newPage(options);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0;padding:16px"><div id="stacked" style="display:flex;flex-direction:column;gap:1rem"><p>Journal</p></div>` +
      `<div id="row" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:24px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#row textarea").waitFor();
  return page;
};

/** The field's box and its children's boxes, relative to the field. */
const fieldBoxes = (page: Page, selector: string) =>
  page.locator(selector).evaluate((field) => {
    const box = field.getBoundingClientRect();
    return {
      height: box.height,
      children: Array.from(field.children, (child) => {
        const part = child.getBoundingClientRect();
        return { class: child.className, top: part.top - box.top, bottom: part.bottom - box.top, height: part.height };
      }),
    };
  });

describe("@k2b/ui fields with a description", () => {
  for (const options of Object.values(viewports)) {
    const width = options.viewport.width;

    test(`at ${width} px a form dialog holds a multi-line field like a stacked form`, async () => {
      const page = await load(options);
      try {
        // The form resolves only when it closes, so the page must not await it.
        await page.evaluate(() => {
          void (globalThis as unknown as { openForm: () => Promise<unknown> }).openForm();
        });
        await page.locator("dialog textarea").waitFor();
        // The stacked field takes the dialog field's width, so its description
        // wraps the same way whatever font the browser falls back to.
        await page.evaluate(() => {
          const { width } = document.querySelector("dialog .k2b-field")!.getBoundingClientRect();
          document.getElementById("stacked")!.style.width = `${width}px`;
        });
        const stacked = await fieldBoxes(page, "#stacked > .k2b-field:last-child");
        const dialog = await fieldBoxes(page, "dialog .k2b-field");
        // Same rows as outside a field group, so the control stays inside its field.
        expect(dialog).toEqual(stacked);
        expect(Math.max(...dialog.children.map((child) => child.bottom))).toBeLessThanOrEqual(dialog.height);

        const layout = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const panel = box("dialog .k2b-dialog__panel");
          return { field: box("dialog .k2b-field").bottom, actions: box("dialog .k2b-dialog__actions"), panel };
        });
        // The actions sit below the field and inside the dialog.
        expect(layout.actions.top).toBeGreaterThanOrEqual(layout.field);
        expect(layout.actions.bottom).toBeLessThanOrEqual(layout.panel.bottom);
      } finally {
        await page.close();
      }
    });

    test(`at ${width} px fields in a row align their controls and hold them`, async () => {
      const page = await load(options);
      try {
        const [described, plain] = await Promise.all([
          fieldBoxes(page, "#row > .k2b-field:first-child"),
          fieldBoxes(page, "#row > .k2b-field:last-child"),
        ]);
        const control = (field: typeof described) => field.children.find((child) => !child.class.startsWith("k2b-field__"))!;
        // The description pushes both controls down to one line.
        expect(control(plain).top).toBe(control(described).top);
        expect(control(plain).top).toBeGreaterThan(described.children[1]!.top);
        for (const field of [described, plain]) {
          expect(Math.max(...field.children.map((child) => child.bottom))).toBeLessThanOrEqual(field.height);
        }
      } finally {
        await page.close();
      }
    });
  }
});
