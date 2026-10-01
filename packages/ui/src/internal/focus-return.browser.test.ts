import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Whether returned focus shows a ring is the engine's :focus-visible
// heuristic, which happy-dom does not model, so a real engine runs the shipped
// browser build of the overlays.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "focus-return.fixture.ts");
const fixture = `
import { createSignal, Show } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Button, ContextMenu, DatePicker, Dropdown, Lightbox, MultiSelectInput, Select, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const options = ["Apples", "Pears", "Plums"].map((label) => ({ value: label.toLowerCase(), label }));
const openDialog = () =>
  void dialogCore.open((close) => {
    const body = document.createElement("div");
    body.innerHTML = "<h2>Rename list</h2><button type='button'>Done</button>";
    body.querySelector("button").onclick = () => close();
    return body;
  });
const menu = (label, items) =>
  createComponent(Dropdown.Root, {
    items,
    get children() {
      return createComponent(Dropdown.Trigger, { size: "sm", variant: "secondary", children: label });
    },
  });

const [photo, setPhoto] = createSignal(false);
const image = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'/>");

render(
  () => [
    createComponent(Button, { size: "sm", variant: "secondary", onClick: openDialog, children: "Rename" }),
    menu("Actions", [{ label: "Export", action: () => {} }, { label: "Archive", action: () => {} }]),
    menu("More", [{ label: "Rename list", action: openDialog }]),
    createComponent(Select, { label: "Fruit", options, value: "pears" }),
    createComponent(Select, { label: "Snack", options, value: "pears", searchable: true }),
    createComponent(MultiSelectInput, { label: "Basket", options, value: ["pears"] }),
    createComponent(DatePicker, { label: "Due", value: "2026-09-30" }),
    createComponent(ContextMenu, { label: "Note", items: [{ label: "Pin", action: () => {} }], children: "Shopping note" }),
    createComponent(Button, { size: "sm", variant: "secondary", onClick: () => setPhoto(true), children: "View photo" }),
    createComponent(Show, {
      get when() {
        return photo();
      },
      get children() {
        return createComponent(Lightbox, { images: [{ src: image, alt: "Empty frame" }], onClose: () => setPhoto(false) });
      },
    }),
    createComponent(AppWorkspace.SidebarItem, { icon: "ti ti-list", children: "Tasks", preview: { label: "Task details", trigger: "row", content: "Three open tasks" } }),
    createComponent(Button, { size: "sm", variant: "secondary", children: "Last" }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the overlay fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

type Overlay = {
  /** The control that opens the overlay and gets focus back. */
  trigger: (page: Page) => ReturnType<Page["locator"]>;
  /** Opens with the keyboard once the trigger has focus. */
  keys: string[];
  /** Opens with a right click rather than a click or tap. */
  contextMenu?: true;
};

const button = (name: string) => (page: Page) => page.getByRole("button", { name, exact: true });
const combobox = (name: string) => (page: Page) => page.getByRole("combobox", { name, exact: true });
const overlays: Record<string, Overlay> = {
  dialog: { trigger: button("Rename"), keys: ["Enter"] },
  "dropdown menu": { trigger: button("Actions"), keys: ["Enter"] },
  "dialog opened from a menu item": { trigger: button("More"), keys: ["Enter", "Enter"] },
  select: { trigger: combobox("Fruit"), keys: ["Enter"] },
  "searchable select": { trigger: combobox("Snack"), keys: ["Enter"] },
  "multi select": { trigger: combobox("Basket"), keys: ["ArrowDown"] },
  "date picker": { trigger: (page) => page.locator(".k2b-date-trigger"), keys: ["Enter"] },
  "context menu": { trigger: (page) => page.getByRole("group", { name: "Note" }), keys: ["Shift+F10"], contextMenu: true },
  lightbox: { trigger: button("View photo"), keys: ["Enter"] },
  "sidebar preview": { trigger: (page) => page.locator("button.k2b-app-workspace__sidebar-item-main"), keys: ["Enter"] },
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
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><main id="app" style="display:flex;flex-direction:column;gap:12px;padding:24px;max-width:320px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Last" }).waitFor();
  return page;
};

/** Every box in the page once transitions, such as a trigger that hides again, have finished. */
const boxes = async (page: Page) => {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#app *"), (element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
    }),
  );
};

/** Waits two frames: overlays move focus in a microtask or the next frame after the input that opens them. */
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

const activeRing = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.matches(":focus-visible")));

/** Tabs to the trigger, as a keyboard user reaches it. */
const tabTo = async (page: Page, overlay: Overlay) => {
  const trigger = overlay.trigger(page);
  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab");
    if (await trigger.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Tab never reached the trigger");
};

/** Opens with a click, or a tap on the phone. */
const pointerOpen = async (page: Page, viewport: string, name: string, overlay: Overlay) => {
  const press = (target: ReturnType<Page["locator"]>) => (viewport === "phone" ? target.tap() : target.click());
  if (overlay.contextMenu) await overlay.trigger(page).click({ button: "right" });
  else await press(overlay.trigger(page));
  if (name === "dialog opened from a menu item") await press(page.getByRole("menuitem", { name: "Rename list" }));
  await settle(page);
  expect(await page.evaluate(() => document.querySelector(":popover-open, dialog[open], .k2b-context-menu") !== null)).toBe(true);
};

const hasFocus = (page: Page, overlay: Overlay) =>
  overlay.trigger(page).evaluate((element) => ({ focused: element === document.activeElement, ring: element.matches(":focus-visible") }));

describe("@k2b/ui overlays return focus with the ring they were opened with", () => {
  for (const [viewport, options] of Object.entries(viewports)) {
    for (const [name, overlay] of Object.entries(overlays)) {
      test(`${name} at ${options.viewport.width} px: a pointer open returns focus without a ring, and the next Tab shows one`, async () => {
        const page = await load(options);
        try {
          await pointerOpen(page, viewport, name, overlay);
          await page.keyboard.press("Escape");
          await settle(page);
          // Screen readers follow focus, so it is back on the trigger, only without a ring.
          expect(await hasFocus(page, overlay)).toEqual({ focused: true, ring: false });
          const silent = await boxes(page);

          await page.keyboard.press("Tab");
          expect(await activeRing(page)).toBe(true);
          // Back on the trigger its ring is on, and nothing moved for it.
          await page.keyboard.press("Shift+Tab");
          expect(await hasFocus(page, overlay)).toEqual({ focused: true, ring: true });
          expect(await boxes(page)).toEqual(silent);
        } finally {
          await page.close();
        }
      });

      test(`${name} at ${options.viewport.width} px: a keyboard open after a silent return brings the ring back`, async () => {
        const page = await load(options);
        try {
          await pointerOpen(page, viewport, name, overlay);
          await page.keyboard.press("Escape");
          await settle(page);
          expect(await hasFocus(page, overlay)).toEqual({ focused: true, ring: false });

          // Keys pressed on a silently focused control do not light its ring.
          for (const key of overlay.keys) {
            await page.keyboard.press(key);
            await settle(page);
          }
          expect(await page.evaluate(() => document.querySelector(":popover-open, dialog[open], .k2b-context-menu") !== null)).toBe(true);
          await page.keyboard.press("Escape");
          await settle(page);
          expect(await hasFocus(page, overlay)).toEqual({ focused: true, ring: true });
        } finally {
          await page.close();
        }
      });

      test(`${name} at ${options.viewport.width} px: a keyboard open returns focus with its ring`, async () => {
        const page = await load(options);
        try {
          await tabTo(page, overlay);
          const closed = await boxes(page);
          for (const key of overlay.keys) {
            await page.keyboard.press(key);
            await settle(page);
          }
          expect(await page.evaluate(() => document.querySelector(":popover-open, dialog[open], .k2b-context-menu") !== null)).toBe(true);

          await page.keyboard.press("Escape");
          await settle(page);
          expect(await hasFocus(page, overlay)).toEqual({ focused: true, ring: true });
          expect(await boxes(page)).toEqual(closed);
        } finally {
          await page.close();
        }
      });
    }
  }
});
