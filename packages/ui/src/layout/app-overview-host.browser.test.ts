import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";
import { workspaceCss } from "../../test/workspace-host-fixture";

const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

test("overview main and aside follow the app host like a window of the same width", async () => {
  for (const [viewport, host, direction] of [
    [1440, 952, "column"],
    [1680, 1192, "row"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: viewport, height: 900 } });
    try {
      // Fix the viewport-based page inset so the comparison isolates the columns.
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
        <body class="k2b-ui" style="margin:0">
          <div id="host" style="container:k2b-app-area / inline-size;width:${host}px">
            <div class="k2b-app-overview" style="--k2b-app-overview-inset:32px">
              <div class="k2b-app-overview__columns">
                <section class="k2b-app-overview__main"><h2>Main</h2><p>Primary content</p></section>
                <aside class="k2b-app-overview__aside"><h2>Aside</h2><p>Supporting content</p></aside>
              </div>
            </div>
          </div>
        </body></html>`);
      const measure = () =>
        page.locator(".k2b-app-overview__columns").evaluate((columns) => ({
          direction: getComputedStyle(columns).flexDirection,
          boxes: Array.from(columns.children, (element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          }),
        }));
      const narrowed = await measure();
      expect(narrowed.direction).toBe(direction);
      const [main, aside] = narrowed.boxes;
      if (direction === "column") {
        expect(aside!.x).toBe(main!.x);
        expect(aside!.y).toBeGreaterThanOrEqual(main!.y + main!.height);
      } else {
        expect(aside!.y).toBe(main!.y);
        expect(aside!.x).toBeGreaterThanOrEqual(main!.x + main!.width);
      }

      await page.setViewportSize({ width: host, height: 900 });
      await page.locator("#host").evaluate((element) => {
        element.style.container = "none";
        element.style.width = "100%";
      });
      expect(await measure()).toEqual(narrowed);
    } finally {
      await page.close();
    }
  }
});
