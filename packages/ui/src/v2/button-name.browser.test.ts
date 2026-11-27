import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// A button with words took its `label` nowhere: assistive technology heard only the words ("Öffnen"), though the
// contract says `label` is the name where the words alone do not say enough (Notebooks, W2). The label is now the
// button's name; words alone, a symbol with its label, and `about` read as before.

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-button-name-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Button } = await import("./button");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");

const markup = [
  renderToString(() => createComponent(Button, { label: "Öffnen: Hausordnung", children: "Öffnen" })),
  renderToString(() => createComponent(Button, { children: "Teilen" })),
  renderToString(() => createComponent(Button, { icon: "x", label: "Schließen" })),
  renderToString(() => createComponent(Button, { label: "Lesen: ganzes Kapitel", about: "kapitel", children: "Lesen", title: "Lesen" })),
].join("");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("a button with words and a label is named by its label; words alone, a symbol and `about` read as before", async () => {
  // the server markup already carries the name, so it holds before any script runs
  expect(markup).toContain('aria-label="Öffnen: Hausordnung"');
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui"><h2 id="kapitel">Kapitel 3</h2>${markup}</body></html>`,
    );
    await settled(page);
    // the accessibility tree, as a screen reader gets it: the name, and after it the words where they differ
    expect(await page.locator("body").ariaSnapshot()).toBe(
      [
        '- heading "Kapitel 3" [level=2]',
        `- 'button "Öffnen: Hausordnung"': Öffnen`,
        '- button "Teilen"',
        '- button "Schließen"',
        `- 'button "Lesen: ganzes Kapitel Kapitel 3"': Lesen`,
      ].join("\n"),
    );
    // the label is no hint under the pointer for a button with words; an icon button keeps its label as the hint
    const titles = await page.evaluate(() => [...document.querySelectorAll(".k2-btn")].map((button) => button.getAttribute("title")));
    expect(titles).toEqual([null, null, "Schließen", "Lesen"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
