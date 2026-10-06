import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../test/browser";

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
    test(`at ${options.viewport.width} px the list scrolls only sideways and keeps the selected underline whole`, async () => {
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
              underlineCut: Math.max(0, selected.bottom - clipBottom),
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
              underlineCut: 0,
            })),
          ),
        );
      } finally {
        await page.close();
      }
    });
  }

  test("in forced colours the line baseline stays drawn in CanvasText and the tabs stay forced", async () => {
    const page = await browser.newPage(viewports.desktop);
    try {
      await page.emulateMedia({ forcedColors: "active" });
      await page.setContent(html());
      const measured = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.style.color = "CanvasText";
        const canvasText = getComputedStyle(probe).color;
        probe.style.color = "var(--k2b-action)";
        const action = getComputedStyle(probe).color;
        probe.style.color = "var(--k2b-text)";
        const text = getComputedStyle(probe).color;
        const named = (value: string) => value.replaceAll(canvasText, "CanvasText").replaceAll(action, "action").replaceAll(text, "text");
        return Array.from(document.querySelectorAll<HTMLElement>(".k2b-tabs__list")).map((list) => ({
          list: list.getAttribute("aria-label"),
          baseline: named(getComputedStyle(list).boxShadow),
          selectedUnderline: named(getComputedStyle(list.querySelector('[aria-selected="true"]')!).borderBottomColor),
        }));
      });
      expect(measured).toEqual(
        ["line", "pill"].flatMap((variant) =>
          [3, 24].map((count) => ({
            list: `${variant} with ${count} tabs`,
            baseline: variant === "line" ? "CanvasText 0px -1px 0px 0px inset" : "none",
            // WebKit matches `forced-colors: active` under emulation but has no forced colours mode that repaints
            // author colours, so only Chromium can show that the tabs stay forced. WebKit keeps the author colours:
            // the line's action underline and the current colour of the borderless pill.
            selectedUnderline: browserName === "chromium" ? "CanvasText" : variant === "line" ? "action" : "text",
          })),
        ),
      );
    } finally {
      await page.close();
    }
  });
});
