import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, devices } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../../test/browser";
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
    test("toolbar formats the cell selection without a view switch; a source view returns to formatted", async () => {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        const errors = pageErrors(page);
        await page.goto(server.url.href);
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.waitFor();
        await settled(page);
        const tableWidth = await cell.evaluate((element) => {
          const wrapper = element.closest(".k2b-ste-table")!;
          // The grip gutter is the wrapper's left padding.
          const gutter = Number.parseFloat(getComputedStyle(wrapper).paddingLeft);
          return { available: wrapper.clientWidth - gutter, table: wrapper.querySelector("table")!.getBoundingClientRect().width };
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
        // Editing is always formatted: the toolbar offers no Formatted/Markdown switch.
        expect(await page.locator(".k2b-ste-views").count()).toBe(0);
        expect(await page.getByRole("radio", { name: "Markdown", exact: true }).count()).toBe(0);
        // A source view (the table check's "Check Markdown") keeps its tools and the way back.
        await page.goto(server.url.href + "?state=source");
        await page.locator(".k2b-ste-views").waitFor();
        expect(await page.locator(".k2b-ste-table").count()).toBe(0);
        await page.getByRole("button", { name: "Tabelle", exact: true }).click();
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toContain("Spalte 1");
        await page.getByRole("radio", { name: "Formatiert", exact: true }).click();
        await page.locator(".k2b-ste-table").first().waitFor();
        expect(await page.locator(".k2b-ste-views").count()).toBe(0);
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
        expect(await page.locator(".k2b-ste-floating-menu .k2b-dropdown__trigger").count()).toBe(0);
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
        if (name === "phone") {
          expect(await source.locator(".k2b-ste-source-body").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
          const heights = await source
            .locator("button:visible")
            .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
          expect(heights.length).toBeGreaterThan(0);
          expect(
            heights.every((height) => height >= 44),
            JSON.stringify(heights),
          ).toBe(true);
        }
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
          expect(gap).toBeLessThanOrEqual(4.5);
        }
      } finally {
        await context.close();
      }
    });
    const polish = async () => {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      const errors = pageErrors(page);
      await page.goto(`${server.url.href}?polish`);
      await page.locator(".k2b-ste-cell").first().waitFor();
      await settled(page);
      const cell = (r: number, c: number) => page.locator(`.k2b-ste-cell[data-r="${r}"][data-c="${c}"]`);
      const openMenu = page.locator(".k2b-ste-table-menu:popover-open");
      const focused = () =>
        page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.r + "," + (document.activeElement as HTMLElement | null)?.dataset.c,
        );
      return { context, page, errors, cell, openMenu, focused };
    };
    test("no cell or header has a menu button; grips sit outside the grid without moving it", async () => {
      const { context, page, errors, cell } = await polish();
      try {
        const table = page.locator(".k2b-ste-table");
        expect(await table.locator(".k2b-dropdown__trigger, .ti-dots").count()).toBe(0);
        expect(await page.locator(".k2b-ste-floating-menu .k2b-dropdown__trigger").count()).toBe(0);
        expect(
          await table
            .locator("button")
            .evaluateAll(
              (buttons) =>
                buttons.filter((button) => /…|\.\.\./.test(button.textContent + (button.getAttribute("aria-label") ?? ""))).length,
            ),
        ).toBe(0);
        const before = await cell(3, 1).boundingBox();
        if (name === "phone") await cell(3, 1).tap();
        else await cell(3, 1).hover();
        await settled(page);
        expect(await cell(3, 1).boundingBox()).toEqual(before);
        const geometry = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const grid = box(".k2b-ste-table table");
          const row = box('tr[data-r="3"] .k2b-ste-rowMenu');
          const column = box('.k2b-ste-columnMenu[data-c="1"]');
          const visible = (selector: string) => getComputedStyle(document.querySelector(selector)!).visibility === "visible";
          return {
            rowRight: row.right,
            columnBottom: column.bottom,
            gridLeft: grid.left,
            gridTop: grid.top,
            rowSize: [row.width, row.height],
            columnSize: [column.width, column.height],
            visible: visible('tr[data-r="3"] .k2b-ste-rowMenu') && visible('.k2b-ste-columnMenu[data-c="1"]'),
            paragraph: document.querySelector(".cm-line")!.getBoundingClientRect().left,
            text: (() => {
              const cell = document.querySelector('.k2b-ste-cell[data-r="3"][data-c="0"]')!;
              const range = document.createRange();
              range.selectNodeContents(cell);
              return range.getBoundingClientRect().left;
            })(),
          };
        });
        expect(geometry.visible).toBe(true);
        expect(geometry.rowRight).toBeLessThanOrEqual(geometry.gridLeft + 0.5);
        expect(geometry.columnBottom).toBeLessThanOrEqual(geometry.gridTop + 0.5);
        // With room beside the text, cell text starts where the paragraphs do and the grip gutter lies left of both.
        if (name === "desktop") expect(Math.abs(geometry.text - geometry.paragraph)).toBeLessThan(1.5);
        if (name === "phone") {
          expect(geometry.rowSize).toEqual([30, 44]);
          expect(geometry.columnSize).toEqual([44, 30]);
          // A taller target than its row: the hidden grip of the next row never takes the tap.
          const hit = await page.evaluate(() => {
            const grip = document.querySelector('tr[data-r="3"] .k2b-ste-rowMenu')!.getBoundingClientRect();
            return document
              .elementFromPoint(grip.left + grip.width / 2, grip.bottom - 2)
              ?.closest("tr")
              ?.getAttribute("data-r");
          });
          expect(hit).toBe("3");
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test("cells of a multi-line row share its height and focus fills the whole cell", async () => {
      const { context, page, errors, cell } = await polish();
      try {
        await cell(1, 1).click();
        await settled(page);
        const rows = await page.locator('tr[data-r="1"]').evaluate((row) => ({
          row: row.getBoundingClientRect().height,
          cells: [...row.querySelectorAll(".k2b-ste-cell")].map((element) => element.getBoundingClientRect().height),
        }));
        expect(rows.cells.length).toBe(5);
        expect(Math.max(...rows.cells) - Math.min(...rows.cells)).toBeLessThan(0.5);
        expect(rows.cells[1]).toBeGreaterThan(50);
        expect(Math.abs(rows.row - rows.cells[1]! - 1)).toBeLessThan(1.5);
        expect(await cell(1, 1).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test.skipIf(name === "phone")("Shift+F10 and the context-menu key open the cell menu; Escape returns to the cell", async () => {
      const { context, page, errors, cell, openMenu, focused } = await polish();
      try {
        for (const key of ["Shift+F10", "ContextMenu"]) {
          await cell(2, 1).click();
          await page.keyboard.press(key);
          await openMenu.waitFor();
          expect(await openMenu.locator(".k2b-dropdown__label").first().textContent()).toBe("Zeile 2 · Spalte „Wer“");
          expect(await page.evaluate(() => document.activeElement?.closest(".k2b-ste-table-menu") !== null)).toBe(true);
          expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Zeile darüber einfügen");
          // The key opens the menu at the cell, not at a button.
          const menu = await openMenu.boundingBox();
          const anchor = await cell(2, 1).boundingBox();
          expect(Math.abs(menu!.x - anchor!.x)).toBeLessThan(1);
          await page.keyboard.press("ArrowDown");
          expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Zeile darunter einfügen");
          await page.keyboard.press("Escape");
          await openMenu.waitFor({ state: "detached" }).catch(() => {});
          expect(await openMenu.count()).toBe(0);
          expect(await focused()).toBe("2,1");
        }
        expect(await cell(2, 1).getAttribute("aria-keyshortcuts")).toBe("Shift+F10");
        // Moving the row keeps the menu open; Escape returns to the moved cell, not to the old place.
        await cell(1, 0).click();
        await page.keyboard.press("Shift+F10");
        await openMenu.getByRole("menuitem", { name: /^Zeile nach unten/ }).click();
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="2"][data-c="0"]'));
        expect(await cell(2, 0).textContent()).toBe("Bühne und Technik");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test.skipIf(name === "phone")("a press beside an open menu only closes it: focus, selection and marks stay", async () => {
      const { context, page, errors, cell, openMenu, focused } = await polish();
      try {
        const before = await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString());
        await cell(1, 0).click();
        await page.keyboard.press("Shift+F10");
        await openMenu.waitFor();
        await cell(2, 3).click();
        expect(await openMenu.count()).toBe(0);
        // Focus returns to the cell the menu came from as the menu closes.
        await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="1"][data-c="0"]'));
        expect(
          await page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest(".k2b-ste-cell")?.getAttribute("data-r")),
        ).not.toBe("2");
        // A column grip marks its column only while its menu is open; the press beside it marks nothing new.
        await cell(1, 2).hover();
        await page.locator('.k2b-ste-columnMenu[data-c="2"]').click();
        await openMenu.waitFor();
        expect(await page.locator("td[data-marked], th[data-marked]").count()).toBe(6);
        expect(await openMenu.locator(".k2b-dropdown__label").first().textContent()).toBe("Spalte „Budget“");
        // The open menu covers the text below the table; press the paragraph above it.
        await page.getByText("Wer kümmert sich um was", { exact: false }).click();
        expect(await openMenu.count()).toBe(0);
        await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="0"][data-c="2"]'));
        expect(await page.locator("[data-marked], .k2b-ste-grip[data-open]").count()).toBe(0);
        // Only that press is swallowed: after a release elsewhere, the next key activation still clicks.
        await page.evaluate(() => {
          const outside = document.getElementById("outside")!;
          outside.dataset.clicks = "0";
          outside.addEventListener("click", () => (outside.dataset.clicks = String(Number(outside.dataset.clicks) + 1)));
        });
        await cell(1, 0).click();
        await page.keyboard.press("Shift+F10");
        await openMenu.waitFor();
        const heading = (await page.getByText("Sommerfest 2027").boundingBox())!;
        await page.mouse.move(heading.x + 5, heading.y + 5);
        await page.mouse.down();
        await page.mouse.move(heading.x + 5, heading.y + 120);
        await page.mouse.up();
        expect(await openMenu.count()).toBe(0);
        await page.locator("#outside").focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("#outside").getAttribute("data-clicks")).toBe("1");
        // Right-click opens at the pointer; Escape returns to its cell.
        await cell(3, 4).click({ button: "right" });
        await openMenu.waitFor();
        await page.keyboard.press("Escape");
        expect(await focused()).toBe("3,4");
        expect(await page.evaluate(() => window.sharedComponentHarness.view.state.doc.toString())).toBe(before);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
