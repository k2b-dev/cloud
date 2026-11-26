import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// A data bar (a chance of rain, a share of a day) is drawn in the soft colour of the app it belongs to; green and red
// are states the caller names, never the default.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-progress-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Progress } = await import("./marks");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const bars = [
  renderToString(() => createComponent(Progress, { value: 60, of: 100, label: "Regen 60 %" })),
  renderToString(() => createComponent(Progress, { value: 60, of: 100, label: "Regen 60 %", color: "#b45309" })),
  renderToString(() => createComponent(Progress, { value: 22, of: 22, label: "Fertig", status: "ok" })),
  renderToString(() => createComponent(Progress, { value: 3, of: 22, label: "Verzug", status: "bad" })),
].join("<br>");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("progress: a data bar in the soft colour of its app (its own `color` for another app), green and red only as named states", async () => {
  for (const theme of [undefined, "dark"] as const) {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><style>${css}</style></head>` +
          `<body class="k2-ui"${theme ? ` data-theme="${theme}"` : ""} style="--k2-app: #0369a1">${bars}</body></html>`,
      );
      await settled(page);
      const found = await page.evaluate(() => {
        const resolve = (value: string) => {
          const probe = document.createElement("i");
          probe.style.backgroundColor = value;
          document.body.append(probe);
          const out = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return out;
        };
        const fills = [...document.querySelectorAll(".k2-progress-track > i")].map((bar) => getComputedStyle(bar).backgroundColor);
        return {
          fills,
          expected: [
            resolve("color-mix(in srgb, #0369a1 55%, var(--k2-surface))"),
            resolve("color-mix(in srgb, #b45309 55%, var(--k2-surface))"),
            resolve("var(--k2-ok)"),
            resolve("var(--k2-bad)"),
          ],
        };
      });
      expect(found.fills).toEqual(found.expected);
    } finally {
      await page.close();
    }
  }
});
