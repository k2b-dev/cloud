import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Which rule wins is decided by the built stylesheet: the build rewrites some
// selectors, so a real engine computes styles from the shipped files.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "content-styles.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { FileView, MarkdownView } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const code = Array.from({ length: 3 }, (_, index) => "const value" + index + " = " + index + ";").join("\\n");
const file = (id, previewLines) => {
  const box = document.createElement("section");
  box.id = id;
  box.style.cssText = "display:flex;flex-direction:column;height:240px";
  render(
    () =>
      createComponent(FileView, {
        file: { path: "src/main.ts", size: code.length },
        load: async () => ({ encoding: "utf8", content: code, mediaType: "text/plain" }),
        previewLines,
      }),
    box,
  );
  return box;
};

const markdown = [
  "Read [the guide](https://example.com) and run \`bun test\`.",
  "",
  "\`\`\`ts",
  "const answer = 42;",
  "\`\`\`",
  "",
  "| Name | Count | Status | Price |",
  "| --- | --- | :-: | --: |",
  "| Apples | 3 | ok | 1.20 |",
].join("\\n");

const app = document.getElementById("app");
app.append(file("full"), file("excerpt", 2));
render(() => createComponent(MarkdownView, { markdown }), app.appendChild(document.createElement("article")));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the content fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head>` +
      `<body class="k2b-ui"><main id="app" style="padding:24px"></main><span id="action" style="color:var(--k2b-action)"></span></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#excerpt .k2b-content-code-display").waitFor();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("@k2b/ui content previews apply their own styles", () => {
  for (const id of ["full", "excerpt"]) {
    test(`a ${id} FileView code preview has no second frame inside the preview frame`, async () => {
      const styles = await page.evaluate((id) => {
        const preview = document.querySelector(`#${id} .k2b-content-file-view__preview`)!;
        const code = preview.querySelector(".k2b-content-code-display")!;
        const style = getComputedStyle(code);
        return {
          margin: style.margin,
          boxShadow: style.boxShadow,
          // The preview frame clips its content to its own rounded corners.
          radius: style.borderRadius === getComputedStyle(code.parentElement!).borderRadius,
          clipped: getComputedStyle(preview).overflow !== "visible",
          top: code.getBoundingClientRect().top - preview.getBoundingClientRect().top - preview.clientTop,
        };
      }, id);
      expect(styles).toEqual({ margin: "0px", boxShadow: "none", radius: true, clipped: true, top: 0 });
    });
  }

  test("a complete FileView code preview fills the preview frame", async () => {
    const { code, frame } = await page.evaluate(() => {
      const preview = document.querySelector("#full .k2b-content-file-view__preview")!;
      return { code: preview.querySelector(".k2b-content-code-display")!.getBoundingClientRect().height, frame: preview.clientHeight };
    });
    expect(code).toBe(frame);
  });

  test("MarkdownView colours links and inline code as actions, and fenced code like its block", async () => {
    const colors = await page.evaluate(() => {
      const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
      return {
        link: color("article a"),
        inline: color("article p code"),
        fenced: color("article pre code"),
        block: color("article pre"),
        action: color("#action"),
      };
    });
    expect(colors.link).toBe(colors.action);
    expect(colors.inline).toBe(colors.action);
    expect(colors.fenced).toBe(colors.block);
    expect(colors.fenced).not.toBe(colors.action);
  });

  test("MarkdownView table headers align with their columns", async () => {
    const alignment = await page.evaluate(() =>
      Array.from(document.querySelectorAll("article thead th"), (header, index) => {
        const cell = document.querySelectorAll("article tbody td")[index]!;
        return [getComputedStyle(header).textAlign, getComputedStyle(cell).textAlign];
      }),
    );
    // Engines report the `align` attribute as their own keyword, such as `-webkit-center`.
    expect(alignment.map(([header]) => header)).toEqual([
      "start",
      "start",
      expect.stringContaining("center"),
      expect.stringContaining("right"),
    ]);
    for (const [header, cell] of alignment) expect(header).toBe(cell!);
  });
});
