/**
 * CodeMirror places every line of a note from its height map and measures blocks without margins. A rendered block
 * that takes more or less room than its box (a margin, an inline label in a taller line box) shifts every line after
 * it away from where the editor thinks it is: clicks, other people's carets, comment positions and the drawn range
 * then miss. Every drawn block of the Notebook editor must sit exactly where the height map places it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../../ui/test/browser";
import { startNotebookEditorFixture } from "./shared-text-editor.browser-fixture";

let browser: Browser;
let server: Awaited<ReturnType<typeof startNotebookEditorFixture>>;
beforeAll(async () => {
  server = await startNotebookEditorFixture();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

const doc = [
  "# Budget",
  "",
  "Wir planen das Budget und halten fest, welche Fragen noch offen sind.",
  "",
  "@costs",
  "| Item | Hours | Cost |",
  "| --- | ---: | ---: |",
  "| Design | 2 | =Hours*50 |",
  "",
  "| Plain | Table |",
  "| --- | --- |",
  "| a | b |",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  ":::info",
  "Hinweis zum Ablauf",
  ":::",
  "",
  "@limits",
  ":::data",
  "budget: 5000",
  "owner: Lena",
  ":::",
  "",
  "- Punkt eins",
  "- [ ] Aufgabe",
  "",
  "```js",
  "const total = 1;",
  "```",
  "",
  "> Ein Zitat",
  "",
  "Ende der Notiz.",
].join("\n");

for (const viewport of [
  { width: 1280, height: 2000 },
  { width: 390, height: 2400 },
])
  test(`every drawn block sits where the editor's height map places it (${viewport.width} px)`, async () => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = pageErrors(page);
    try {
      const url = new URL(server.url.href);
      url.searchParams.set("doc", doc);
      await page.goto(url.href);
      await page.waitForFunction(() => window.noteHarness?.ready());
      await page.evaluate(() => window.noteHarness.settle());
      expect(await page.evaluate(() => window.noteHarness.blockDrift())).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
