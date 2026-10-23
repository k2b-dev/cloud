import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, devices } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/text-editor-component-harness";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [new URL("../../test/text-editor-component-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser", "production"],
    format: "iife",
    plugins: [
      {
        name: "text-editor-component-source",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: new URL("../index.ts", import.meta.url).pathname }));
          builder.onResolve({ filter: /^@k2b\/ui\/text-editor$/ }, () => ({
            path: new URL("../text-editor.ts", import.meta.url).pathname,
          }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Component fixture failed to build");
  const script = await build.outputs[0]!.text();
  const editorCss = await Bun.file(new URL("../styles/text-editor.css", import.meta.url)).text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
      if (path === "/text-editor.css") return new Response(editorCss, { headers: { "content-type": "text/css" } });
      if (/^\/assets\/(?:fonts\/)?[\w.-]+$/.test(path))
        return new Response(Bun.file(new URL(`../../dist/${path.slice(8)}`, import.meta.url)));
      return new Response(
        '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/global.css"><link rel="stylesheet" href="/text-editor.css"><style>body{margin:0}main{max-width:760px;margin:20px auto;padding:16px}</style></head><body class="k2b-ui"><main><div id="root"></div><button id="outside">Outside</button></main><script src="/fixture.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
const { defaultBrowserType: _, ...phone } = devices[browserName === "webkit" ? "iPhone 15" : "Pixel 7"];
const profiles: Record<string, BrowserContextOptions> = { desktop: { viewport: { width: 1440, height: 900 } }, phone };
for (const [name, options] of Object.entries(profiles))
  describe(name, () => {
    test("toolbar formats the cell selection and source mode clears its floating menu", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(server.url.href);
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.waitFor();
        await settled(page);
        const tableWidth = await cell.evaluate((element) => {
          const wrapper = element.closest(".k2b-ste-table")!;
          return { available: wrapper.clientWidth, table: wrapper.querySelector("table")!.getBoundingClientRect().width };
        });
        expect(tableWidth.table).toBeGreaterThanOrEqual(tableWidth.available - (name === "desktop" ? 32 : 0));
        await cell.click();
        await cell.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await page.getByRole("button", { name: "Fett", exact: true }).click();
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toContain("**Visitenkarten**");
        await page.getByRole("radio", { name: "Markdown", exact: true }).click();
        expect(await page.locator(".k2b-ste-table").count()).toBe(0);
        expect(await page.locator(".k2b-ste-floating-menu").count()).toBe(0);
        await page.getByRole("button", { name: "Tabelle", exact: true }).click();
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toContain("Spalte 1");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test("rejected input remains copyable through notice dismissal", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        await page.goto(server.url.href + "?state=error");
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("1");
        await page.keyboard.press("End");
        await page.keyboard.type("!");
        const recovery = page.locator(".k2b-ste-recovery");
        expect(await recovery.inputValue()).toBe("Visitenkarten!");
        expect(await page.locator(".k2b-ste-cell").first().getAttribute("contenteditable")).toBe("false");
        await page.getByRole("button", { name: "Schließen", exact: true }).click();
        expect(await recovery.inputValue()).toBe("Visitenkarten!");
        await page.getByRole("button", { name: "Gesicherte Eingabe verwerfen", exact: true }).click();
        expect(await recovery.count()).toBe(0);
        expect(await page.locator(".k2b-ste-cell").first().getAttribute("contenteditable")).toBe("plaintext-only");
      } finally {
        await context.close();
      }
    });
    test("cell context menu opens from the keyboard and alignment applies", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        await page.goto(server.url.href);
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.keyboard.press("Shift+F10");
        const center = page.getByRole("menuitemradio", { name: "Mitte" });
        await center.waitFor();
        await settled(page);
        const activeCell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        const targetOutline = await activeCell.evaluate((element) => {
          const style = getComputedStyle(element);
          return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        });
        expect(targetOutline.style).toBe("solid");
        expect(targetOutline.width).toBeGreaterThan(0);
        const alignment = await center.evaluate((button) => {
          const section = button.closest(".k2b-dropdown__section")!;
          const label = section.querySelector(".k2b-dropdown__label")!.getBoundingClientRect();
          const choices = section.querySelector(".k2b-dropdown__row")!.getBoundingClientRect();
          return {
            labelRight: label.right,
            choicesLeft: choices.left,
            labelCenter: label.top + label.height / 2,
            choicesCenter: choices.top + choices.height / 2,
          };
        });
        expect(alignment.labelRight).toBeLessThanOrEqual(alignment.choicesLeft);
        expect(Math.abs(alignment.labelCenter - alignment.choicesCenter)).toBeLessThan(1);
        await center.click();
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toContain("| :---: |");
        await page.keyboard.press("Escape");
        await page.locator("#outside").click();
        expect(await page.locator(".k2b-ste-floating-menu").count()).toBe(0);
        await page.waitForFunction(() => {
          const cell = document.querySelector('.k2b-ste-cell[data-r="1"][data-c="0"]');
          return cell && getComputedStyle(cell).outlineStyle === "none";
        });
        expect(await activeCell.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
      } finally {
        await context.close();
      }
    });
    test("local table source keeps Markdown rows unwrapped and preserves the space below", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        await page.goto(`${server.url.href}?mockup`);
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.waitFor();
        await settled(page);
        const following = page.getByText("Viele Grüße", { exact: true });
        const top = await following.evaluate((element) => element.getBoundingClientRect().top + scrollY);
        await cell.click();
        await page.keyboard.press("Shift+F10");
        await page.getByRole("menuitem", { name: "Als Markdown bearbeiten", exact: true }).click();
        const source = page.locator(".k2b-ste-table-source");
        await source.waitFor();
        await settled(page);
        expect(await source.locator(".cm-content").evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre");
        expect(await following.evaluate((element) => element.getBoundingClientRect().top + scrollY)).toBe(top);
        if (name === "phone")
          expect(await source.locator(".k2b-ste-source-body").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await source.getByRole("button", { name: name === "phone" ? "Fertig" : "Als Tabelle anzeigen", exact: true }).click();
        await source.waitFor({ state: "detached" });
        expect(await cell.isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    });
    test("the add-column control stays beyond the last column of a wide table", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        await page.goto(server.url.href);
        await page.waitForFunction(() => !!window.sharedComponentHarness);
        await page.evaluate(() => {
          const columns = Array.from({ length: 10 }, (_, index) => `Long column heading ${index + 1}`);
          const doc = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.join(" | ")} |`;
          const view = window.sharedComponentHarness.view;
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
        });
        const wrapper = page.locator(".k2b-ste-table");
        await wrapper.waitFor();
        await settled(page);
        expect(await wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        const add = wrapper.locator(".k2b-ste-addColumn");
        if (name === "phone") expect(await add.isVisible()).toBe(false);
        else {
          const gap = await wrapper.evaluate((element) => {
            const table = element.querySelector("table")!.getBoundingClientRect();
            const add = element.querySelector(".k2b-ste-addColumn")!.getBoundingClientRect();
            return add.left - table.right;
          });
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThan(1);
        }
      } finally {
        await context.close();
      }
    });
  });
