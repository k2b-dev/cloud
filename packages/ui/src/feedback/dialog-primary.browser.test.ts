import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-primary.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent } from "solid-js";
import { Button, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
document.addEventListener("test-open", event => void dialogCore.open(
  () => createComponent(Button, { children: "Continue" }),
  { primary: event.detail.primary, ariaLabel: event.detail.title },
));
`,
  },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog primary fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (page: Page, title: string, primary?: "blue" | "ai") => {
  await page.evaluate((detail) => document.dispatchEvent(new CustomEvent("test-open", { detail })), { title, primary });
  await page.getByRole("dialog", { name: title, exact: true }).waitFor();
  await settled(page);
};

for (const theme of ["light", "dark"] as const) {
  test(`a dialog can choose blue inside an AI document and restores each level's palette (${theme})`, async () => {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    try {
      await page.setContent(`<!doctype html><style>${css}</style><body class="k2b-ui" data-theme="${theme}" data-k2b-primary="ai">
        <button id="opener">Ask AI</button></body>`);
      await page.addScriptTag({ content: script });
      await page.locator("#opener").focus();
      await open(page, "AI work");
      const color = () => page.locator("dialog[open] > :last-child button").evaluate((button) => getComputedStyle(button).backgroundColor);
      const ai = await color();
      expect(ai).toBe(theme === "light" ? "rgb(142, 27, 111)" : "rgb(183, 64, 143)");
      await open(page, "Session", "blue");
      const blue = theme === "light" ? "rgb(29, 78, 216)" : "rgb(37, 99, 235)";
      expect(await color()).toBe(blue);
      // A normal child keeps the explicit blue scope, and an AI child can opt back in.
      await open(page, "Ordinary child");
      expect(await color()).toBe(blue);
      await open(page, "AI child", "ai");
      expect(await color()).toBe(ai);
      expect(errors).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Ordinary child", exact: true }).waitFor();
      expect(await color()).toBe(blue);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "AI work", exact: true }).waitFor();
      expect(await color()).toBe(ai);
    } finally {
      await page.close();
    }
  });
}
