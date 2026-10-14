import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";

let browser: Browser;
let css: string;
beforeAll(async () => {
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

test("Book cycles ordered ancestors through decimal, alpha and roman and keeps the start", async () => {
  const markdown =
    "3. root\n   1. alpha\n      1. roman\n         1. decimal\n            1. alpha again\n               1. roman again\n   - bullet\n     1. alpha through bullet";
  const { html } = renderNotebookBook({ markdown, notebookId: "book01", locale: "en" });
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><article class="notebook-book-content">${html}</article></body></html>`,
    );
    const lists = await page
      .locator(".notebook-book-content ol")
      .evaluateAll((elements) =>
        elements.map((element) => ({ style: getComputedStyle(element).listStyleType, start: element.getAttribute("start") })),
      );
    expect(lists.map(({ style }) => style)).toEqual([
      "decimal",
      "lower-alpha",
      "lower-roman",
      "decimal",
      "lower-alpha",
      "lower-roman",
      "lower-alpha",
    ]);
    expect(lists[0]!.start).toBe("3");
  } finally {
    await page.close();
  }
});
