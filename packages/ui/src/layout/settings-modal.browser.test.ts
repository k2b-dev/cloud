import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// Which box a focus scrolls is decided by layout, which happy-dom does not
// model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-settings-modal-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { CheckboxCard } = await import("../inputs/CheckboxCard");
const { SettingsGroup, SettingsPanelFooter } = await import("./Settings");
const { default: SettingsModal } = await import("./SettingsModal");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const viewports = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 664 },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const card = (label: string) =>
  createComponent(CheckboxCard, { label, description: "Shown on the public page.", value: true, variant: "input" });

/** A panel several times taller than its dialog, with a checkbox card in every group. */
const modal = () =>
  renderToString(() =>
    createComponent(SettingsModal, {
      title: "Venue settings",
      onClose: () => {},
      get children() {
        return [
          createComponent(SettingsModal.Tab, {
            id: "general",
            title: "General",
            get children() {
              return [
                ...Array.from({ length: 12 }, (_, index) =>
                  createComponent(SettingsGroup, {
                    title: `Group ${index + 1}`,
                    description: "A group of settings.",
                    get children() {
                      return card(`Option ${index + 1}`);
                    },
                  }),
                ),
                createComponent(SettingsModal.Footer, {
                  get children() {
                    return createComponent(SettingsPanelFooter, { changeCount: 1, loading: false, onDiscard: () => {}, onSave: () => {} });
                  },
                }),
              ];
            },
          }),
          createComponent(SettingsModal.Tab, { id: "access", title: "Access", children: "Access" }),
        ];
      },
    }),
  );

// The wrapper is what applications put around the modal to size it inside their dialog.
const openDialog = async (viewport: { width: number; height: number }) => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><dialog class="k2b-dialog k2b-dialog--large is-bare"><div class="k2b-dialog__viewport is-bare">` +
      `<div style="display:flex;height:86vh;min-height:0;flex-direction:column;overflow:hidden">${modal()}</div></div></dialog></body></html>`,
  );
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  return page;
};

/** Where the frame, its panel and its footer sit, and every box other than the panel that scrolled. */
const layout = () => {
  const edges = (selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
  };
  const scrolled = Array.from(document.querySelectorAll("*"))
    .filter((element) => (element.scrollTop || element.scrollLeft) && !element.matches(".k2b-settings__body"))
    .map((element) => element.className || element.tagName);
  return {
    frame: edges(".k2b-settings"),
    rail: edges(".k2b-settings__rail"),
    panel: edges(".k2b-settings__body"),
    footer: edges(".k2b-settings__footer"),
    scrolled,
  };
};

/** Adds a visually hidden control without a positioned ancestor of its own, as applications render them, and focuses it. */
const focusHiddenControl = ({ parent, style }: { parent: string; style: string }) => {
  const control = document.createElement("input");
  control.id = "hidden-control";
  control.style.cssText = `position:absolute;width:1px;height:1px;opacity:0;${style}`;
  document.querySelector(parent)!.append(control);
  control.focus();
};

describe("@k2b/ui SettingsModal scrolling", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    test(`scrolls the panel to a visually hidden control at the end of a tab on a ${name}`, async () => {
      const page = await openDialog(viewport);
      try {
        const before = await page.evaluate(layout);
        await page.evaluate(focusHiddenControl, { parent: ".k2b-settings__section", style: "" });
        expect(await page.evaluate(layout)).toEqual(before);

        // The control scrolls with the panel, so focusing it reveals the option it belongs to.
        const control = await page.locator("#hidden-control").boundingBox();
        expect(control!.y).toBeGreaterThan(before.panel.top);
        expect(control!.y + control!.height).toBeLessThanOrEqual(before.panel.bottom);
        expect(await page.locator(".k2b-settings__body").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    });

    test(`keeps the frame in place with its footer at the bottom when a control beyond it takes focus on a ${name}`, async () => {
      const page = await openDialog(viewport);
      try {
        const before = await page.evaluate(layout);
        expect(before.footer.bottom).toBeGreaterThan(before.frame.bottom - 4);
        expect(before.panel.bottom).toBe(before.footer.top);

        // The panel contains whatever a tab renders, so the control sits in the frame itself to lie beyond it.
        await page.evaluate(focusHiddenControl, { parent: ".k2b-settings", style: "top:300%" });
        expect(await page.evaluate(layout)).toEqual(before);
      } finally {
        await page.close();
      }
    });
  }
});
