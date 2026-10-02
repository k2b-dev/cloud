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
import { BottomSheet, bottomSheetOptions, dialogCore, PanelDialog, panelDialogFixedOptions, panelDialogOptions, panelDialogWideOptions, panelDialogWorkspaceOptions, prompts } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

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

/** A custom body that opts into shrinking: a min-height 0 column whose list scrolls above its own action row. */
const shrinking = (close) => {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:1rem;min-height:0";
  const list = long();
  list.dataset.list = "";
  list.style.cssText = "min-height:0;overflow-y:auto";
  const row = document.createElement("div");
  row.dataset.row = "";
  row.append(Done({ close }));
  root.append(list, row);
  return root;
};

/** A short custom body that ends in its own buttons, the last one an xs icon button at the edge. */
const buttons = (close) => {
  const icon = Done({ close });
  icon.classList.add("k2b-icon-button");
  icon.dataset.size = "xs";
  icon.textContent = "×";
  icon.setAttribute("aria-label", "More actions");
  const row = document.createElement("div");
  row.dataset.end = "";
  row.style.cssText = "display:flex;justify-content:flex-end;gap:0.5rem";
  row.append(Done({ close }), icon);
  return row;
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
  "shrinking custom dialog": () => void prompts.dialog((close) => shrinking(close), { title: "Customize toolbar", size: "large" }),
  "short custom dialog": () => void prompts.dialog((close) => buttons(close), { title: "Publish changes" }),
  "unstructured content": () => void dialogCore.open(() => long()),
  "panel dialog": panel(panelDialogOptions),
  "wide panel dialog": panel(panelDialogWideOptions),
  "fixed panel dialog": panel(panelDialogFixedOptions),
  "workspace panel dialog": panel(panelDialogWorkspaceOptions),
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
  desktop: { viewport: { width: 1440, height: 900 } },
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
  "workspace panel dialog": ".k2b-panel-dialog__footer",
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

    // A workspace is a work area: a floating card on a desktop, the whole
    // screen on a phone instead of a narrow card with a wide margin.
    test(`a workspace panel dialog frame at ${options.viewport.width} px`, async () => {
      const page = await open(options, "workspace panel dialog");
      try {
        const frame = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
          const box = dialog.getBoundingClientRect();
          const style = getComputedStyle(dialog);
          return {
            edgeToEdge: box.left === 0 && box.top === 0 && box.width === innerWidth && box.height === innerHeight,
            radius: style.borderTopLeftRadius,
            border: style.borderTopStyle,
          };
        });
        if (options.viewport.width < 768) expect(frame).toEqual({ edgeToEdge: true, radius: "0px", border: "none" });
        else expect(frame).toEqual({ edgeToEdge: false, radius: "14px", border: "solid" });
      } finally {
        await page.close();
      }
    });

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

    // A body with a min-height 0 root asks to shrink to the frame, so only its
    // own list scrolls and its action row stays below it, as on a laptop or phone.
    test(`a shrinking custom dialog body fits its frame at ${options.viewport.width} px`, async () => {
      const page = await open(options, "shrinking custom dialog");
      try {
        await scrollToEnd(page);
        const content = await page.evaluate(() => {
          const region = document.querySelector("dialog[open] .k2b-dialog__content")!;
          const list = document.querySelector("dialog[open] [data-list]")!;
          return { regionScrolls: region.scrollHeight > region.clientHeight, listScrolled: list.scrollTop > 0 };
        });
        expect(content).toEqual({ regionScrolls: false, listScrolled: true });
        expect(await layout(page, "[data-row]")).toEqual({ frameScrolled: 0, header: true, footer: true, end: true });
      } finally {
        await page.close();
      }
    });

    // On touch, a button's hit area reaches past its box; at the edge of the
    // content region it must not leave a short body a few pixels to scroll.
    test(`a short custom dialog that ends in its own buttons does not scroll at ${options.viewport.width} px`, async () => {
      const page = await open(options, "short custom dialog");
      try {
        const overflow = await page.evaluate(() => {
          const region = document.querySelector("dialog[open] .k2b-dialog__content")!;
          return { block: region.scrollHeight - region.clientHeight, inline: region.scrollWidth - region.clientWidth };
        });
        expect(overflow).toEqual({ block: 0, inline: 0 });
      } finally {
        await page.close();
      }
    });
  }
});
