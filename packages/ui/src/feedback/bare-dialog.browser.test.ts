import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../test/browser";

// How tall a frame becomes is a layout result, which happy-dom does not model, so a real engine runs the shipped
// browser build and stylesheet.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "bare-dialog.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { dialogCore, prompts, ScrollArea, SettingsModal } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const text = (value) => {
  const paragraph = document.createElement("p");
  paragraph.textContent = value;
  return paragraph;
};

/** A grid of app tiles in a padded scroll area, as an app launcher draws its own bare surface. */
const tiles = () => {
  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:1rem;width:30rem";
  for (let index = 0; index < 12; index += 1) {
    const tile = document.createElement("a");
    tile.href = "#app-" + index;
    tile.textContent = "App " + (index + 1);
    tile.style.cssText = "display:grid;place-items:center;width:3rem;height:3rem";
    grid.append(tile);
  }
  return grid;
};

window.openVariant = {
  // An application's settings: a settings modal in a frame of fixed height that the content sets itself.
  settings: () =>
    void prompts.dialog(
      (close) => {
        const frame = document.createElement("div");
        frame.dataset.content = "";
        frame.style.cssText = "display:flex;height:min(86dvh,40rem);min-height:0;flex-direction:column;overflow:hidden";
        frame.append(
          createComponent(SettingsModal, {
            title: "Settings",
            onClose: () => close(),
            get children() {
              return createComponent(SettingsModal.Tab, { id: "general", title: "General", get children() { return text("Name"); } });
            },
          }),
        );
        return frame;
      },
      { surface: "bare", header: false, size: "large" },
    ),
  "app grid": () =>
    void dialogCore.open(
      () => {
        const area = createComponent(ScrollArea, { style: { padding: "1.75rem" }, get children() { return tiles(); } });
        area.dataset.content = "";
        return area;
      },
      { panelClassName: "k2b-dialog k2b-dialog--large is-bare", contentClassName: "k2b-dialog__viewport is-bare" },
    ),
  "full bare dialog": () =>
    void prompts.dialog(
      () => {
        const content = text("A document");
        content.dataset.content = "";
        return content;
      },
      { surface: "bare", header: false, size: "full" },
    ),
  search: () => void prompts.search(() => [{ value: "notes", label: "Notes" }], { title: "Find" }),
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the bare dialog fixture for the browser.");
const script = await build.outputs[0]!.text();

// iPadOS reports a coarse pointer without hover, also with a trackpad attached, and its windows on an external
// display reach thousands of pixels: the sizes of the Chrome and Safari windows in which bare dialogs collapsed.
const ipad = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const conditions: Record<string, BrowserContextOptions> = {
  "iPad Chrome window on an external display": { ...ipad, viewport: { width: 2294, height: 1319 } },
  "iPad Safari window on an external display": { ...ipad, viewport: { width: 3008, height: 1602 } },
  "iPad in landscape": { ...ipad, viewport: { width: 1194, height: 834 } },
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The open frame, its content viewport, and the content inside it. */
const open = async (options: BrowserContextOptions, variant: string) => {
  const page = await browser.newPage(options);
  try {
    await page.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.evaluate((name) => (window as unknown as { openVariant: Record<string, () => void> }).openVariant[name]!(), variant);
    await page.locator("dialog[open] .k2b-dialog__viewport").waitFor();
    return await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
      const viewport = dialog.querySelector<HTMLElement>(".k2b-dialog__viewport")!;
      const content = dialog.querySelector("[data-content]");
      const height = (element: Element | null) => (element ? Math.round(element.getBoundingClientRect().height) : null);
      return {
        coarse: matchMedia("(pointer: coarse)").matches,
        // The computed height keeps a percentage as written, so it shows what the frame's height depends on.
        viewportHeight: viewport.computedStyleMap().get("height")!.toString(),
        frame: height(dialog),
        frameInside: dialog.clientHeight,
        viewport: height(viewport),
        content: height(content),
        budget: Math.round(Number.parseFloat(getComputedStyle(viewport).maxHeight)),
      };
    });
  } finally {
    await page.close();
  }
};

describe("@k2b/ui bare dialogs take their content's height in every input mode", () => {
  for (const [condition, options] of Object.entries(conditions)) {
    // A frame without a fixed height takes its content's height. A viewport sized as a percentage of that height
    // depends on itself, and Safari on iPadOS resolves it to 0: the frame collapsed and only the backdrop showed.
    for (const variant of ["settings", "app grid"]) {
      test(`${variant} on ${condition}`, async () => {
        const frame = await open(options, variant);
        expect(frame.coarse).toBe(options.hasTouch === true);
        expect(frame.viewportHeight).toBe("auto");
        expect(frame.content).toBeGreaterThan(100);
        expect(frame.viewport).toBe(frame.content);
        expect(frame.frame).toBe(frame.content);
      });
    }

    // Frames of fixed height still hand their height to the content, up to the dialog budget.
    for (const variant of ["full bare dialog", "search"]) {
      test(`${variant} fills its frame on ${condition}`, async () => {
        const frame = await open(options, variant);
        expect(frame.frameInside).toBeGreaterThan(100);
        expect(frame.viewport).toBe(Math.min(frame.frameInside, frame.budget));
      });
    }
  }
});
