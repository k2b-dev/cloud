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

const openDialog = async (viewport: { width: number; height: number }) => {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><dialog class="k2b-dialog k2b-dialog--large is-bare"><div class="k2b-dialog__viewport is-bare">` +
      `<div style="display:flex;height:86vh;min-height:0;flex-direction:column">${modal()}</div></div></dialog></body></html>`,
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

describe("@k2b/ui SettingsModal frame", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    test(`keeps its size and its footer at the bottom when the last option is switched on a ${name}`, async () => {
      const page = await openDialog(viewport);
      try {
        const before = await page.evaluate(layout);
        expect(before.footer.bottom).toBeGreaterThan(before.frame.bottom - 4);
        expect(before.panel.bottom).toBe(before.footer.top);

        const panel = page.locator(".k2b-settings__body");
        await panel.evaluate((element) => element.scrollTo(0, element.scrollHeight));
        await page.locator(".k2b-checkbox-card").last().click();
        expect(await page.evaluate(layout)).toEqual(before);
        expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    });

    test(`scrolls only the panel when a control beyond the frame takes focus on a ${name}`, async () => {
      const page = await openDialog(viewport);
      try {
        const before = await page.evaluate(layout);
        await page.evaluate(() => {
          // An application's own visually hidden control at the end of the panel. It resolves against the
          // settings frame instead of the panel, so it stays at the panel's full unscrolled height.
          const control = document.createElement("input");
          control.style.cssText = "position:absolute;width:1px;height:1px;opacity:0";
          document.querySelector(".k2b-settings__section")!.append(control);
          control.focus();
        });
        expect(await page.evaluate(layout)).toEqual(before);
      } finally {
        await page.close();
      }
    });
  }
});
