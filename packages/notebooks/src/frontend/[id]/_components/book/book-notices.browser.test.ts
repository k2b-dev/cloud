import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";

// Book view links the app's stylesheet before Cloud's global one, so which
// notice rule wins is decided by the shipped cascade, not by the source.
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

test("a Book notice reads at the note's text size, as in the PDF export", async () => {
  const { html } = renderNotebookBook({
    markdown: "Before the move.\n\n:::warning\nBack up the shared drive first.\n:::\n",
    notebookId: "book01",
    locale: "en",
  });
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><article class="notebook-book-content">${html}</article></body></html>`,
    );
    const sizes = await page.evaluate(() => {
      const type = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return `${style.fontSize}/${style.lineHeight}`;
      };
      return { prose: type(".notebook-book-content > p"), notice: type(".k2b-notice-card__body p") };
    });
    expect(sizes).toEqual({ prose: "16px/28px", notice: "16px/26px" });
  } finally {
    await page.close();
  }
});
