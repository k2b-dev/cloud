import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Scroll overflow depends on layout, which happy-dom does not model, so a real
// engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-tabs-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Tabs } = await import("./Tabs");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
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

const lists = () =>
  renderToString(() =>
    (["line", "pill"] as const).flatMap((variant) =>
      [3, 24].map((count) =>
        createComponent(Tabs, {
          value: "tab-0",
          onValueChange: () => {},
          ariaLabel: `${variant} with ${count} tabs`,
          variant,
          options: Array.from({ length: count }, (_, index) => ({ value: `tab-${index}`, label: `Section ${index + 1}` })),
        }),
      ),
    ),
  );
const html = () =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
  `<body class="k2b-ui" style="margin:0"><main style="display:grid;gap:1rem;padding:1.5rem">${lists()}</main></body></html>`;

describe("@k2b/ui tab list scrolling", () => {
  for (const options of Object.values(viewports)) {
    test(`at ${options.viewport.width} px the list scrolls only sideways and keeps the selected control whole`, async () => {
      const page = await browser.newPage(options);
      try {
        await page.setContent(html());
        const measured = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-tabs__list")).map((list) => {
            const style = getComputedStyle(list);
            const selected = list.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
            const clipBottom = list.getBoundingClientRect().top + list.clientTop + list.clientHeight;
            return {
              list: list.getAttribute("aria-label"),
              overflow: `${style.overflowX} ${style.overflowY}`,
              scrollbar: style.scrollbarWidth,
              verticalOverflow: list.scrollHeight - list.clientHeight,
              scrollsSideways: list.scrollWidth > list.clientWidth,
              selectionCut: Math.max(0, selected.bottom - clipBottom),
            };
          }),
        );
        expect(measured).toEqual(
          ["line", "pill"].flatMap((variant) =>
            [3, 24].map((count) => ({
              list: `${variant} with ${count} tabs`,
              overflow: "auto hidden",
              scrollbar: "thin",
              verticalOverflow: 0,
              // Twenty-four tabs overflow both widths; three fit on a phone too.
              scrollsSideways: count === 24,
              selectionCut: 0,
            })),
          ),
        );
      } finally {
        await page.close();
      }
    });
  }

  test("forced colours keep the soft baseline and mark selection without changing geometry", async () => {
    const page = await browser.newPage(viewports.desktop);
    try {
      await page.emulateMedia({ forcedColors: "active" });
      await page.setContent(html());
      const measured = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2b-tabs__list")).map((list) => {
          const selected = getComputedStyle(list.querySelector('[aria-selected="true"]')!);
          return {
            baseline: getComputedStyle(list).boxShadow,
            underlineWidth: selected.borderBottomWidth,
            selection: selected.textDecorationLine,
          };
        }),
      );
      expect(measured).toHaveLength(4);
      for (const item of measured) {
        expect(item.baseline).toBe("none");
        expect(item.underlineWidth).toBe("0px");
        expect(item.selection).toContain("underline");
      }
    } finally {
      await page.close();
    }
  });
});

// A selected tab past the list's edge is revealed by scrolling the list alone. `scrollIntoView` also scrolled every
// ancestor, so a review page opened scrolled down below its header.
const dist = resolve(import.meta.dir, "../../dist/browser/index.js");
const mountEntry = resolve(import.meta.dir, "tabs-reveal.fixture.ts");
const mountFixture = `
import { createComponent, render } from "solid-js/web";
import { SettingsModal, Tabs } from ${JSON.stringify(dist)};

const sections = Array.from({ length: 24 }, (_, index) => ({ value: "tab-" + index, label: "Section " + (index + 1) }));
render(() => createComponent(Tabs, { ariaLabel: "Files", value: "tab-20", onValueChange: () => {}, options: sections }), document.getElementById("tabs"));
render(
  () =>
    createComponent(SettingsModal, {
      title: "Settings",
      defaultTab: "s-20",
      get children() {
        return sections.map((section, index) =>
          createComponent(SettingsModal.Tab, { id: "s-" + index, title: section.label, children: section.label }),
        );
      },
    }),
  document.getElementById("settings"),
);
`;
const mountBuild = await Bun.build({ entrypoints: [mountEntry], files: { [mountEntry]: mountFixture }, target: "browser", format: "iife" });
if (!mountBuild.success) throw new AggregateError(mountBuild.logs, "Could not bundle the tab reveal fixture for the browser.");
const mountScript = await mountBuild.outputs[0]!.text();

describe("@k2b/ui selected tab reveal", () => {
  for (const options of Object.values(viewports)) {
    test(`at ${options.viewport.width} px a mounted strip shows its selected tab without moving any outer scroller`, async () => {
      const page = await browser.newPage(options);
      try {
        // Both strips start below the fold of a scrolling panel inside a scrolling page.
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
            `<body class="k2b-ui" style="margin:0"><div style="height:150vh"><div id="panel" style="height:50vh;overflow:auto">` +
            `<div style="height:80vh"></div><div id="tabs"></div><div id="settings" style="height:24rem"></div><div style="height:80vh"></div>` +
            `</div></div></body></html>`,
        );
        await page.addScriptTag({ content: mountScript });
        await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 48);
        // The reveal runs in a microtask; two frames are well past it.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const measured = await page.evaluate(() => {
          const reveal = (list: Element, selected: Element) => {
            const strip = list.getBoundingClientRect();
            const tab = selected.getBoundingClientRect();
            return {
              scrolled: list.scrollLeft + list.scrollTop > 0,
              whole:
                tab.left >= strip.left - 0.5 &&
                tab.right <= strip.right + 0.5 &&
                tab.top >= strip.top - 0.5 &&
                tab.bottom <= strip.bottom + 0.5,
            };
          };
          const tabs = document.querySelector('#tabs [role="tablist"]')!;
          const settings = document.querySelector('#settings [role="tablist"]')!;
          return {
            page: window.scrollY,
            panel: document.getElementById("panel")!.scrollTop,
            tabs: reveal(tabs, tabs.querySelector('[aria-selected="true"]')!),
            settings: reveal(settings, settings.querySelector('[data-active="true"]')!),
          };
        });
        expect(measured).toEqual({ page: 0, panel: 0, tabs: { scrolled: true, whole: true }, settings: { scrolled: true, whole: true } });
      } finally {
        await page.close();
      }
    });
  }
});
