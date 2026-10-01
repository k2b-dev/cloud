import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Which box scrolls is decided by layout, which happy-dom does not model, so a
// real engine runs the shipped browser build and stylesheet.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "dialog-scroll.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { BottomSheet, bottomSheetOptions, dialogCore, PanelDialog, panelDialogFixedOptions, panelDialogOptions, panelDialogWideOptions, prompts } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

/** Content several viewports tall that ends in a marker the test scrolls to. */
const long = () => {
  const content = document.createElement("div");
  for (let index = 0; index < 60; index += 1) {
    const line = document.createElement("p");
    line.textContent = "Line " + (index + 1) + " of a long preview.";
    content.append(line);
  }
  const end = document.createElement("p");
  end.dataset.end = "";
  end.textContent = "End of content";
  content.append(end);
  return content;
};

const panel = (options) => () =>
  void dialogCore.open(
    (close) =>
      createComponent(PanelDialog, {
        get children() {
          return [
            createComponent(PanelDialog.Header, { title: "Edit record", close: () => close() }),
            createComponent(PanelDialog.Body, { get children() { return long(); } }),
            createComponent(PanelDialog.Footer, { get children() { return createComponent(Done, { close }); } }),
          ];
        },
      }),
    options,
  );

const Done = (props) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "k2b-button";
  button.textContent = "Save";
  button.onclick = () => props.close();
  return button;
};

const fields = Object.fromEntries(Array.from({ length: 30 }, (_, index) => ["field" + index, { type: "text", label: "Field " + (index + 1) }]));
fields.end = { type: "info", content: () => long().lastElementChild };

window.openVariant = {
  alert: () => void prompts.alert(long(), { title: "Release notes" }),
  confirm: () => void prompts.confirm(long(), { title: "Apply changes" }),
  "typed confirm": () => void prompts.confirm(long(), { title: "Delete project", confirmationPhrase: "Atlas", variant: "danger" }),
  error: () => void prompts.error(long(), { title: "Import failed" }),
  form: () => void prompts.form({ title: "Add member", fields }),
  "custom dialog": () => void prompts.dialog(() => long(), { title: "notes.txt", size: "large" }),
  "full custom dialog": () => void prompts.dialog(() => long(), { title: "notes.txt", size: "full" }),
  "unstructured content": () => void dialogCore.open(() => long()),
  "panel dialog": panel(panelDialogOptions),
  "wide panel dialog": panel(panelDialogWideOptions),
  "fixed panel dialog": panel(panelDialogFixedOptions),
  "bottom sheet": () =>
    void dialogCore.open(
      (close, { requestDismiss }) =>
        createComponent(BottomSheet, {
          onDismiss: requestDismiss,
          get children() {
            return [
              createComponent(PanelDialog.Header, { title: "Filters", close: () => close() }),
              createComponent(PanelDialog.Body, { get children() { return long(); } }),
              createComponent(PanelDialog.Footer, { get children() { return createComponent(Done, { close }); } }),
            ];
          },
        }),
      bottomSheetOptions,
    ),
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/** Variants with a footer whose actions must stay reachable next to the header. */
const footers: Record<string, string> = {
  alert: ".k2b-dialog__actions",
  confirm: ".k2b-dialog__actions",
  "typed confirm": ".k2b-dialog__actions",
  error: ".k2b-dialog__actions",
  form: ".k2b-dialog__actions",
  "panel dialog": ".k2b-panel-dialog__footer",
  "wide panel dialog": ".k2b-panel-dialog__footer",
  "fixed panel dialog": ".k2b-panel-dialog__footer",
  "bottom sheet": ".k2b-panel-dialog__footer",
};
const variants = [...Object.keys(footers), "custom dialog", "full custom dialog"];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: (typeof viewports)[keyof typeof viewports], variant: string) => {
  const page = await browser.newPage(options);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.evaluate((name) => (window as unknown as { openVariant: Record<string, () => void> }).openVariant[name]!(), variant);
  await page.locator("dialog[open] [data-end]").waitFor({ state: "attached" });
  // The bottom sheet slides in; measure where it rests.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  return page;
};

/** Brings the end of the content into view, as a wheel, a swipe, or Tab to the last field does. */
const scrollToEnd = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        document.querySelector("dialog[open] [data-end]")!.scrollIntoView({ block: "end" });
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );

/** Where the header, footer, and end marker sit relative to the visible dialog frame. */
const layout = (page: Page, footer: string | undefined) =>
  page.evaluate(
    ({ footer }) => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
      const frame = dialog.getBoundingClientRect();
      const inside = (selector: string | undefined) => {
        const element = selector ? dialog.querySelector(selector) : null;
        if (!element) return selector ? null : true;
        const box = element.getBoundingClientRect();
        return box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5 && box.bottom <= innerHeight + 0.5;
      };
      return {
        frameScrolled: dialog.scrollTop,
        header: inside(".k2b-dialog__header, .k2b-panel-dialog__header"),
        footer: inside(footer),
        end: inside("[data-end]"),
      };
    },
    { footer },
  );

describe("@k2b/ui dialogs keep their header and actions in view while the body scrolls", () => {
  for (const options of Object.values(viewports)) {
    for (const variant of variants) {
      test(`${variant} at ${options.viewport.width} px`, async () => {
        const page = await open(options, variant);
        try {
          await scrollToEnd(page);
          expect(await layout(page, footers[variant])).toEqual({ frameScrolled: 0, header: true, footer: true, end: true });
        } finally {
          await page.close();
        }
      });
    }

    // Content without a header, body, or footer structure cannot shrink, so
    // the frame itself stays the scroll container that reaches its end.
    test(`unstructured content still scrolls in its frame at ${options.viewport.width} px`, async () => {
      const page = await open(options, "unstructured content");
      try {
        await scrollToEnd(page);
        const { frameScrolled, end } = await layout(page, undefined);
        expect(frameScrolled).toBeGreaterThan(0);
        expect(end).toBe(true);
      } finally {
        await page.close();
      }
    });
  }
});
