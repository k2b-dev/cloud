import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Whether header actions fit their panel is layout, which happy-dom does not model, so a real engine renders the
// shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-data-panel-header-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: DataTable } = await import("./DataTable");
const { Button } = await import("../actions/Button");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const html = renderToString(() =>
  createComponent(DataTable.Panel, {
    get children() {
      return createComponent(DataTable.Header, {
        title: "Model profiles",
        subtitle: "Models, credentials, capabilities, and endpoint policies.",
        get children() {
          return ["JSON exportieren", "JSON importieren", "Anbieter hinzufügen"].map((label) =>
            createComponent(Button, { size: "sm", children: label }),
          );
        },
      });
    },
  }),
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("@k2b/ui panel header actions", () => {
  test.each([
    [358, "wrap inside a phone-wide panel instead of running out of it"],
    [900, "share one row on a wide panel"],
  ])("at %i px they %s", async (width) => {
    const page = await browser.newPage({ viewport: { width: Math.max(width + 32, 390), height: 800 } });
    try {
      await page.setContent(
        `<!doctype html><html lang="en"><head><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0;padding:16px"><div style="width:${width}px">${html}</div></body></html>`,
      );
      const layout = await page.evaluate(() => {
        const panel = document.querySelector(".k2b-data-panel")!;
        const right = panel.getBoundingClientRect().right;
        const buttons = Array.from(document.querySelectorAll(".k2b-panel-header__actions .k2b-button"), (button) => {
          const box = button.getBoundingClientRect();
          return { top: Math.round(box.top), right: Math.round(box.right) };
        });
        return { right: Math.round(right), buttons, clipped: panel.scrollWidth > panel.clientWidth };
      });
      expect(layout.clipped).toBe(false);
      for (const button of layout.buttons) expect(button.right).toBeLessThanOrEqual(layout.right);
      const rows = new Set(layout.buttons.map((button) => button.top)).size;
      if (width < 400) expect(rows).toBeGreaterThan(1);
      else expect(rows).toBe(1);
    } finally {
      await page.close();
    }
  });
});
