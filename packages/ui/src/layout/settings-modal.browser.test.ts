import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

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
  browser = await launchBrowser();
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

/** Two groups with more categories than a phone row shows. */
const crowdedModal = () =>
  renderToString(() =>
    createComponent(SettingsModal, {
      title: "Mailbox settings",
      onClose: () => {},
      get children() {
        return ["Personal", "Compose", "Mailbox", "Delivery"].map((group) =>
          createComponent(SettingsModal.Group, {
            title: group,
            get children() {
              return [1, 2].map((index) =>
                createComponent(SettingsModal.Tab, { id: `${group}-${index}`.toLowerCase(), title: `${group} ${index}`, children: group }),
              );
            },
          }),
        );
      },
    }),
  );

describe("@k2b/ui SettingsModal separation", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    test(`separates groups and the category list from the panel without lines on a ${name}`, async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui"><div style="height:86vh;display:flex;flex-direction:column">${crowdedModal()}</div></body></html>`,
        );
        await settled(page);
        const lines = await page.evaluate(() => {
          const sides = ["top", "right", "bottom", "left"];
          const selectors = [
            ".k2b-settings__rail",
            ".k2b-settings__tabs",
            ".k2b-settings__tab-group",
            ".k2b-settings__content",
            ".k2b-settings__body",
          ];
          return {
            borders: selectors.flatMap((selector) =>
              Array.from(document.querySelectorAll(selector)).flatMap((element) => {
                const style = getComputedStyle(element);
                return sides
                  .filter((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0)
                  .map((side) => `${selector} ${side}`);
              }),
            ),
            separators: document.querySelectorAll('.k2b-settings__rail :is(hr, [role="separator"])').length,
          };
        });
        expect(lines).toEqual({ borders: [], separators: 0 });
      } finally {
        await page.close();
      }
    });
  }

  test("forced colours keep a line beside the desktop rail, where rail and panel both become Canvas", async () => {
    const page = await browser.newPage({ viewport: viewports.desktop });
    try {
      await page.emulateMedia({ forcedColors: "active" });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head>` +
          `<body class="k2b-ui"><div style="height:86vh;display:flex;flex-direction:column">${crowdedModal()}</div></body></html>`,
      );
      await settled(page);
      expect(await page.locator(".k2b-settings__rail").evaluate((rail) => getComputedStyle(rail).borderRightStyle)).toBe("solid");
    } finally {
      await page.close();
    }
  });

  test("the phone row fades out into the last category it cuts", async () => {
    const page = await browser.newPage({ viewport: viewports.phone });
    try {
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui"><div style="height:86vh;display:flex;flex-direction:column">${crowdedModal()}</div></body></html>`,
      );
      // The island measures the overflow and sets this attribute; the page is only server-rendered here.
      await page.locator(".k2b-settings__tabs").evaluate((element) => element.setAttribute("data-scroll-fade", "bottom"));
      await settled(page);
      const fade = await page.locator(".k2b-settings__tabs").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          overflows: element.scrollWidth > element.clientWidth,
          masked: style.maskImage.includes("linear-gradient"),
          reachesPastPadding:
            Number.parseFloat(style.getPropertyValue("--scroll-fade-size")) * 16 > Number.parseFloat(style.paddingRight) + 16,
        };
      });
      expect(fade).toEqual({ overflows: true, masked: true, reachesPastPadding: true });

      // Selecting a category scrolls it into view the way the modal does; it must stop outside the fade.
      const revealed = await page.locator(".k2b-settings__tabs").evaluate((row) => {
        const tab = row.querySelectorAll<HTMLElement>('[role="tab"]')[5]!;
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        const fadeSize = Number.parseFloat(getComputedStyle(row).getPropertyValue("--scroll-fade-size")) * 16;
        return tab.getBoundingClientRect().right <= row.getBoundingClientRect().right - fadeSize + 1;
      });
      expect(revealed).toBe(true);
    } finally {
      await page.close();
    }
  });
});

/** A rail with the longest category label of Mail's mailbox settings. */
const groupedModal = () =>
  renderToString(() =>
    createComponent(SettingsModal, {
      title: "Postfach-Einstellungen",
      onClose: () => {},
      get children() {
        return [
          createComponent(SettingsModal.Group, {
            title: "Postfach",
            get children() {
              return createComponent(SettingsModal.Tab, { id: "general", title: "Allgemein", icon: "ti ti-id", children: "General" });
            },
          }),
          createComponent(SettingsModal.Group, {
            title: "Zustellung",
            get children() {
              return createComponent(SettingsModal.Tab, {
                id: "delivery",
                title: "Konten und Identitäten",
                icon: "ti ti-send",
                children: "Delivery",
              });
            },
          }),
        ];
      },
    }),
  );

describe("@k2b/ui SettingsModal category labels", () => {
  // The rail may wrap a label to two lines; whether it needs to depends on the engine's font.
  for (const [name, viewport, maxLines] of [
    ["desktop rail at 1440", { width: 1440, height: 900 }, 2],
    ["phone row", viewports.phone, 1],
  ] as const) {
    test(`shows a long category label in full in the ${name}`, async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui"><div style="height:86vh;display:flex;flex-direction:column">${groupedModal()}</div></body></html>`,
        );
        await settled(page);
        const label = await page
          .locator('[role="tab"]', { hasText: "Konten und Identitäten" })
          .locator("span")
          .evaluate((element) => ({
            overflowsInline: element.scrollWidth > element.clientWidth,
            overflowsBlock: element.scrollHeight > element.clientHeight,
            lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
          }));
        expect({ overflowsInline: label.overflowsInline, overflowsBlock: label.overflowsBlock }).toEqual({
          overflowsInline: false,
          overflowsBlock: false,
        });
        expect(label.lines).toBeLessThanOrEqual(maxLines);
      } finally {
        await page.close();
      }
    });
  }
});
