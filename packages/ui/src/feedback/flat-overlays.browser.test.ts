import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

// K16 in a real engine: a dialog error grows the dialog upwards, menu rows reach the menu's edges, and a submenu opens
// beside its row by pointer and keyboard, or one level at a time in the phone sheet. Invented entries only.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "flat-overlays.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Button, Dropdown, dialogCore, LocaleProvider, PanelDialog, panelDialogOptions } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.chosen = [];
const choose = (label) => () => window.chosen.push(label);
const items = [
  { label: "Upload", icon: "ti ti-upload", action: choose("Upload") },
  { label: "New folder", icon: "ti ti-folder-plus", action: choose("New folder") },
  {
    items: [
      {
        label: "From template",
        icon: "ti ti-template",
        submenu: [
          {
            label: "Office",
            icon: "ti ti-folder",
            submenu: [
              { label: "Offer", action: choose("Offer") },
              { label: "Invoice", action: choose("Invoice") },
            ],
          },
          { label: "Workshop", icon: "ti ti-folder", action: choose("Workshop") },
          { label: "Shop", icon: "ti ti-folder", action: choose("Shop") },
        ],
      },
      { label: "Archive", icon: "ti ti-archive", action: choose("Archive") },
    ],
  },
];

const [error, setError] = createSignal();
window.setDialogError = (value) => setError(value);
window.openDialog = () =>
  void dialogCore.open(
    (close) =>
      createComponent(PanelDialog, {
        get children() {
          return [
            createComponent(PanelDialog.Header, { title: "New task", close: () => close() }),
            createComponent(PanelDialog.Body, {
              get children() {
                const text = document.createElement("p");
                text.textContent = "Invented task for the browser test.";
                return text;
              },
            }),
            createComponent(PanelDialog.Footer, {
              get error() {
                return error();
              },
              get children() {
                return createComponent(Button, { class: "create", children: "Create" });
              },
            }),
          ];
        },
      }),
    panelDialogOptions,
  );

render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(Dropdown, {
          label: "New",
          phone: "sheet",
          items,
          get children() {
            return createComponent(Dropdown.Trigger, { class: "trigger", children: "New" });
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the flat overlays fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width = 1024, height = 768, justify = "start", align = "start") => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 768 });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><main id="app" style="box-sizing:border-box;display:flex;justify-content:${justify};align-items:${align};height:100vh;padding:16px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".trigger").waitFor();
  return page;
};

const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim());
const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} has no box`);
  return rect;
};

describe("flat overlays (K16)", () => {
  test("a dialog error is a cell above the footer; the footer stays and the frame grows upwards", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as { openDialog: () => void }).openDialog());
      await page.locator("dialog[open] .create").waitFor();
      // Past the entrance motion, which moves the frame by a few pixels.
      await page.waitForTimeout(400);
      const look = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
        const frame = getComputedStyle(dialog);
        const veil = getComputedStyle(dialog, "::backdrop");
        return { radius: frame.borderTopLeftRadius, filter: veil.backdropFilter, veil: veil.backgroundColor };
      });
      expect(look.radius).toBe("8px");
      expect(look.filter).toBe("none");
      expect(look.veil).toBe("rgba(9, 9, 11, 0.28)");

      const before = await box(page, "dialog[open] .create");
      const frameBefore = await box(page, "dialog[open]");
      await page.evaluate(() =>
        (window as unknown as { setDialogError: (value: unknown) => void }).setDialogError({
          title: "The task was not created",
          description: "No connection to the server. Your entries stay.",
        }),
      );
      await page.getByRole("alert").waitFor();
      await settled(page);
      const after = await box(page, "dialog[open] .create");
      const frameAfter = await box(page, "dialog[open]");
      const cell = await box(page, ".k2b-panel-dialog__error");
      const footer = await box(page, ".k2b-panel-dialog__footer");
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(frameAfter.y + frameAfter.height - (frameBefore.y + frameBefore.height))).toBeLessThanOrEqual(1);
      expect(frameAfter.y).toBeLessThan(frameBefore.y - cell.height + 2);
      // Edge to edge, the footer's first row under its line, above its buttons.
      expect(Math.abs(cell.x - frameAfter.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(cell.width - frameAfter.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(cell.y - footer.y - 1)).toBeLessThanOrEqual(1);
      expect(cell.y + cell.height).toBeLessThanOrEqual(after.y - 8);
      expect(cell.height).toBeGreaterThanOrEqual(52);

      // Cleared, the cell leaves and the footer still stays.
      await page.evaluate(() => (window as unknown as { setDialogError: (value: unknown) => void }).setDialogError(undefined));
      await page.locator(".k2b-panel-dialog__error").waitFor({ state: "detached" });
      await settled(page);
      expect(Math.abs((await box(page, "dialog[open] .create")).y - before.y)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  test("menu rows reach every edge; a submenu opens beside its row by pointer and keyboard", async () => {
    const page = await load();
    try {
      await page.locator(".trigger").click();
      const menu = page.locator(".k2b-dropdown__menu:popover-open").first();
      await menu.waitFor();
      const menuBox = await box(page, ".k2b-dropdown__menu:popover-open");
      const first = await box(page, ".k2b-dropdown__menu:popover-open .k2b-dropdown__item");
      expect(first.y - menuBox.y).toBeLessThanOrEqual(1);
      expect(first.x - menuBox.x).toBeLessThanOrEqual(1);
      expect(Math.abs(first.width - menuBox.width)).toBeLessThanOrEqual(2);

      // Pointer: resting on the row opens its menu beside it, level with the row.
      const row = page.getByRole("menuitem", { name: "From template" });
      // hover: the boxes are read after the menu settled, from where it stands then.
      await hoverInPlace(row);
      const submenu = page.getByRole("menu", { name: "From template" });
      await submenu.waitFor();
      expect(await row.getAttribute("aria-expanded")).toBe("true");
      const rowBox = (await row.boundingBox())!;
      const subBox = (await submenu.boundingBox())!;
      expect(Math.abs(subBox.y + 1 - rowBox.y)).toBeLessThanOrEqual(1);
      expect(subBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width - 2);

      // The way to the submenu crosses "Archive" below the row and closes nothing.
      const archive = (await page.getByRole("menuitem", { name: "Archive" }).boundingBox())!;
      await page.mouse.move(rowBox.x + rowBox.width - 30, rowBox.y + rowBox.height / 2);
      await page.mouse.move(archive.x + archive.width - 4, archive.y + 4, { steps: 4 });
      await page.mouse.move(subBox.x + 20, subBox.y + 40, { steps: 4 });
      await page.waitForTimeout(400);
      expect(await submenu.isVisible()).toBe(true);

      // Keyboard: Right opens the third level and moves into it; Left closes one level; Escape closes the next.
      await page.getByRole("menuitem", { name: "Office" }).focus();
      await page.keyboard.press("ArrowRight");
      const third = page.getByRole("menu", { name: "Office" });
      await third.waitFor();
      expect(await focused(page)).toBe("Offer");
      await page.keyboard.press("ArrowLeft");
      await third.waitFor({ state: "detached" });
      expect(await focused(page)).toBe("Office");
      await page.keyboard.press("Escape");
      await submenu.waitFor({ state: "detached" });
      expect(await menu.isVisible()).toBe(true);
      expect(await focused(page)).toBe("From template");

      // Enter opens, Down moves, Enter chooses the entry and the whole menu closes.
      await page.keyboard.press("Enter");
      await submenu.waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await menu.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => (window as unknown as { chosen: string[] }).chosen)).toEqual(["Workshop"]);
    } finally {
      await page.close();
    }
  });

  test("near the right edge a submenu turns to the left", async () => {
    const page = await load(1024, 768, "end");
    try {
      await page.locator(".trigger").click();
      await page.locator(".k2b-dropdown__menu:popover-open").waitFor();
      await settled(page);
      const menuBox = await box(page, ".k2b-dropdown__menu:popover-open");
      await page.getByRole("menuitem", { name: "From template" }).click();
      const submenu = page.getByRole("menu", { name: "From template" });
      await submenu.waitFor();
      await settled(page);
      const subBox = (await submenu.boundingBox())!;
      expect(subBox.x + subBox.width).toBeLessThanOrEqual(menuBox.x + 2);
      expect(await submenu.getAttribute("data-side")).toBe("left");
    } finally {
      await page.close();
    }
  });

  test("near the bottom edge a submenu rises until its last row is level with its row", async () => {
    const page = await load(1024, 768, "start", "end");
    try {
      await page.locator(".trigger").click();
      const row = page.getByRole("menuitem", { name: "From template" });
      await row.click();
      const submenu = page.getByRole("menu", { name: "From template" });
      await submenu.waitFor();
      await settled(page);
      const rowBox = (await row.boundingBox())!;
      const subBox = (await submenu.boundingBox())!;
      expect(subBox.y).toBeLessThan(rowBox.y - 1);
      expect(Math.abs(subBox.y + subBox.height - 1 - (rowBox.y + rowBox.height))).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  test("on a phone the sheet shows one level at a time with Back at its top", async () => {
    const page = await load(390, 760);
    try {
      await page.locator(".trigger").tap();
      const sheet = page.locator("dialog[open] .k2b-gesture-menu__sheet-menu");
      await sheet.waitFor();
      await sheet.getByRole("menuitem", { name: "From template" }).tap();
      const back = sheet.getByRole("menuitem", { name: "Back from From template" });
      await back.waitFor();
      expect(await sheet.getByRole("menuitem").allTextContents()).toEqual(["From template", "Office", "Workshop", "Shop"]);
      expect(await sheet.getByRole("menuitem", { name: "Upload" }).count()).toBe(0);
      await back.tap();
      await sheet.getByRole("menuitem", { name: "Upload" }).waitFor();
      expect(await page.locator("dialog[open]").evaluate((dialog) => getComputedStyle(dialog).borderTopLeftRadius)).toBe("14px");
    } finally {
      await page.close();
    }
  });
});
