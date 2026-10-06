import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { renderHelpMarkdown, renderMarkdownSync } from "../shared/markdown";

// Cloud's rendered Markdown sits inside `MarkdownView` in Help, legal pages,
// announcements and dialogs. Which rule wins there is decided by the compiled
// global stylesheet, so a real engine computes the styles.
let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const source = [
  "See the [site plan](https://example.com/plan).",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Room | Area |",
  "| --- | --: |",
  "| Hall | 42 |",
  "",
  "| Shelf | Items |",
  "| --- | --: |",
  "| A | 12 |",
].join("\n");

for (const theme of ["light", "dark"] as const) {
  test(`Cloud Markdown in MarkdownView stays calm and readable in ${theme}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui">` +
          `<i id="muted" style="background: var(--ui-surface-muted)"></i><i id="surface" style="background: var(--k2b-surface)"></i>` +
          `<div id="plain" class="k2b-content-markdown">${renderMarkdownSync(source)}</div>` +
          `<div class="k2b-panel-dialog__section-body"><div id="group" class="k2b-content-markdown">${renderMarkdownSync(source)}</div></div>` +
          `<div id="help" class="k2b-content-markdown help-document">${renderHelpMarkdown(source)}</div>` +
          `</body></html>`,
      );
      const result = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const tables = Array.from(document.querySelectorAll("#plain .md-table-wrap"), (wrap) => wrap.getBoundingClientRect());
        const code = (host: string) => {
          const pre = style(`${host} .md-code-block pre`);
          return { fill: pre.backgroundColor, ring: pre.boxShadow, edge: pre.borderTopColor };
        };
        return {
          muted: style("#muted").backgroundColor,
          surface: style("#surface").backgroundColor,
          link: style("#plain a.md-link-widget").textDecorationLine,
          plain: code("#plain"),
          group: code("#group"),
          help: code("#help"),
          tableGap: tables[1]!.top - tables[0]!.bottom,
          fontSize: Number.parseFloat(style("#plain").fontSize),
        };
      });
      const frameless = (fill: string) => ({ fill, ring: "none", edge: "rgba(0, 0, 0, 0)" });
      expect({
        link: result.link,
        plain: result.plain,
        help: result.help,
        group: result.group,
        separated: result.tableGap >= result.fontSize - 0.5,
      }).toEqual({
        // The widget's brackets, weight and icon mark it as a link, as in Assistant chat.
        link: "none",
        // Code blocks are a fill without a frame everywhere, Help included.
        plain: frameless(result.muted),
        help: frameless(result.muted),
        // On a tinted group the fill follows `--k2b-field-surface`, so the block keeps an edge.
        group: frameless(result.surface),
        // Two tables in a row keep the prose block spacing, so they do not read as one.
        separated: true,
      });
    } finally {
      await page.close();
    }
  }, 30_000);
}
