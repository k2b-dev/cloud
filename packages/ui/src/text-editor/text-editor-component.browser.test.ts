import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, devices } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
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
        await center.click();
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toContain("| :---: |");
        await page.keyboard.press("Escape");
        await page.locator("#outside").click();
        expect(await page.locator(".k2b-ste-floating-menu").count()).toBe(0);
      } finally {
        await context.close();
      }
    });
  });
