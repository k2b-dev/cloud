import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, devices } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
import type {} from "../../test/text-editor-browser-harness";

let browser: Browser;
const pageErrors: string[] = [];
afterEach(() => {
  const errors = pageErrors.splice(0);
  expect(errors).toEqual([]);
});
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../../test/text-editor-browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Editor harness build failed");
  const bundle = await build.outputs[0]!.text();
  const css = await Bun.file(new URL("../styles/text-editor.css", import.meta.url)).text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/harness.js"
        ? new Response(bundle, { headers: { "content-type": "application/javascript" } })
        : new Response(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font-family:Arial;--k2b-text:#18181b;--k2b-surface:#fff;--k2b-border:#ddd;--k2b-accent:#2563eb;--k2b-accent-subtle:#eff6ff;--k2b-font-sans:Arial} ${css}</style></head><body class="k2b-ui"><div id="root" class="k2b-ste-host"></div><button id="after-editor">After editor</button><script src="/harness.js"></script></body></html>`,
            { headers: { "content-type": "text/html" } },
          ),
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
    const open = async () => {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(server.url.href);
      await page.waitForSelector(".k2b-ste-cell");
      return { context, page };
    };
    test("typing edits only its cell; Tab, Shift-Tab and Enter preserve the following paragraph", async () => {
      const { context, page } = await open();
      try {
        const before = await page.evaluate(() => window.sharedEditorHarness.text());
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.click();
        await page.keyboard.press("End");
        await page.keyboard.type(" stock  more");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(before.replace("Paper", "Paper stock  more"));
        await page.keyboard.press("Tab");
        expect(await page.locator(":focus").getAttribute("data-c")).toBe("1");
        await page.keyboard.press("Shift+Tab");
        expect(await page.locator(":focus").getAttribute("data-c")).toBe("0");
        const edited = await page.evaluate(() => window.sharedEditorHarness.text());
        await page.keyboard.press("Enter");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("2");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(edited);
        await page.keyboard.press("Enter");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("3");
        await page.keyboard.type("New");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("| Ink | 2 |\n| New  |   |\n\nAfter");
      } finally {
        await context.close();
      }
    });
    test("ragged cells save input and formatting targets the selected cell", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("Before\n\n| A | B |\n| --- | --- |\n| x |\n\nAfter"));
        const missing = page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]');
        await missing.click();
        await page.keyboard.type("saved");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("saved");
        await page.evaluate(() => {
          const cell = document.activeElement!;
          const range = document.createRange();
          range.selectNodeContents(cell);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          window.sharedEditorHarness.format();
        });
        const text = await page.evaluate(() => window.sharedEditorHarness.text());
        expect(text).toContain("**saved**");
        expect(text.startsWith("Before\n")).toBe(true);
      } finally {
        await context.close();
      }
    });
    test("a same-size remote column replacement keeps focus and actions on the surviving cell", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("| A | B | C |\n| --- | --- | --- |\n| a | b | c |"));
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
        await page.keyboard.press("End");
        await page.evaluate(() => window.sharedEditorHarness.swapColumn());
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["b", "c", ""]);
        expect(await page.locator(":focus").getAttribute("data-c")).toBe("0");
        await page.keyboard.type("!");
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["b!", "c", ""]);
        await page.evaluate(() => window.sharedEditorHarness.action("deleteCol"));
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["c", ""]);
      } finally {
        await context.close();
      }
    });
    test("IME completion follows a surviving cell through a same-size column change", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("| A | B | C | D |\n| --- | --- | --- | --- |\n| a | b | c | d |"));
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="2"]').click();
        await page.evaluate(() => {
          const cell = document.activeElement!;
          cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          cell.textContent = "c日本";
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(false);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
          window.sharedEditorHarness.swapColumn();
          cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        });
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["b", "c日本", "d", ""]);
        expect(await page.locator(":focus").getAttribute("data-c")).toBe("1");
        await page.keyboard.type("!");
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["b", "c日本!", "d", ""]);
        await page.evaluate(() => window.sharedEditorHarness.action("deleteCol"));
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["b", "d", ""]);
      } finally {
        await context.close();
      }
    });
    test("remote structure cannot replace a neighbour from an unmaterialized cell", async () => {
      const { context, page } = await open();
      try {
        for (const composing of [false, true]) {
          await page.evaluate(() => window.sharedEditorHarness.load("| A | B | C |\n| --- | --- | --- |\n| x |"));
          await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
          await page.evaluate((composing) => {
            const cell = document.activeElement!;
            if (composing) {
              cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
              cell.textContent = "新";
            }
            window.sharedEditorHarness.shiftColumn();
            if (composing) cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "新" }));
            else {
              // A late native input must not use the new occupant as its baseline either.
              cell.textContent = "new";
              cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "new" }));
            }
          }, composing);
          expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("| x |");
          expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain(composing ? "recovery:新" : "recovery:new");
          expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').textContent()).toBe("x");
        }
      } finally {
        await context.close();
      }
    });
    test("formatting an untouched missing cell does not change its neighbour or prose", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("Before\n\n| A | B |\n| --- | --- |\n| x |\n\nAfter"));
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
        await page.evaluate(() => window.sharedEditorHarness.format());
        await page.keyboard.type("new");
        const text = await page.evaluate(() => window.sharedEditorHarness.text());
        expect(text).toContain("**new**");
        expect(text).toContain("| x |");
        expect(text.startsWith("Before\n")).toBe(true);
        expect(text.endsWith("\nAfter")).toBe(true);
      } finally {
        await context.close();
      }
    });
    test("cell formatting and remote input preserve the selected range", async () => {
      const { context, page } = await open();
      try {
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.evaluate(() => {
          const cell = document.activeElement!;
          const range = document.createRange();
          range.selectNodeContents(cell);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
          window.sharedEditorHarness.format("bold");
        });
        expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("Paper");
        await page.evaluate(() => window.sharedEditorHarness.format("italic"));
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("***Paper***");
        await page.evaluate(() => {
          const from = window.sharedEditorHarness.text().indexOf("Paper");
          window.sharedEditorHarness.remote(from, "new ");
        });
        expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("Paper");
        await page.evaluate(() => window.sharedEditorHarness.format("link"));
        expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("https://");
        await page.keyboard.type("https://example.com");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("[Paper](https://example.com)");
      } finally {
        await context.close();
      }
    });
    test("host history handles keyboard and native undo in every mode and respects read-only", async () => {
      const { context, page } = await open();
      try {
        for (const mode of ["formatted", "source", "plain"] as const) {
          await page.evaluate((mode) => {
            window.sharedEditorHarness.load("Text", false, 2097152, true);
            window.sharedEditorHarness.mode(mode);
            window.sharedEditorHarness.selection(4);
          }, mode);
          await page.keyboard.press(name === "phone" && browserName === "webkit" ? "Meta+z" : "Control+z");
          await page
            .locator(".cm-content")
            .evaluate((el) =>
              el.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true })),
            );
          expect(await page.evaluate(() => window.sharedEditorHarness.calls())).toEqual(["undo", "redo"]);
          await page.evaluate(() => window.sharedEditorHarness.readOnly(true));
          await page
            .locator(".cm-content")
            .evaluate((el) =>
              el.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })),
            );
          expect(await page.evaluate(() => window.sharedEditorHarness.calls())).toEqual(["undo", "redo"]);
        }
      } finally {
        await context.close();
      }
    });
    test("HTML fragments keep inline runs and literal fenced code", async () => {
      const { context, page } = await open();
      try {
        for (const [html, expected] of [
          ["<b>one </b><i>two</i>", "**one** *two*"],
          ["<blockquote><b>one </b><i>two</i></blockquote>", "> **one** *two*"],
          ["<blockquote><p>one</p><p>two</p></blockquote>", "> one\n> \n> two"],
          ["<pre>one\n\n\nthree\n```\nend</pre>", "````\none\n\n\nthree\n```\nend\n````"],
        ]) {
          await page.evaluate(() => {
            window.sharedEditorHarness.load("");
            window.sharedEditorHarness.selection(0);
          });
          await page.locator(".cm-content").evaluate((el, html) => {
            const data = new DataTransfer();
            data.setData("text/html", html!);
            el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          }, html);
          expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(expected!);
        }
      } finally {
        await context.close();
      }
    });
    test("vertical arrows traverse wrapped lines before crossing table boundaries", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => {
          document.getElementById("root")!.style.width = "280px";
          window.sharedEditorHarness.load(
            `${"paragraph ".repeat(20)}\n| A | B |\n| --- | --- |\n| ${"wrapped ".repeat(15)} | y |\n| next | z |`,
          );
          window.sharedEditorHarness.selection(0);
        });
        await page.keyboard.press("ArrowDown");
        expect(await page.locator(":focus").getAttribute("class")).toContain("cm-content");
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.evaluate(() => {
          const cell = document.activeElement!;
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(true);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
        });
        await page.keyboard.press("ArrowDown");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("1");
        await page.evaluate(() => {
          const cell = document.activeElement!;
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(false);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
        });
        await page.keyboard.press("ArrowDown");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("2");
      } finally {
        await context.close();
      }
    });
    test("inactive cells render nested emphasis but leave code and escaped markers literal", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() =>
          window.sharedEditorHarness.load(
            "| A | B |\n| --- | --- |\n| ***nested*** | `**literal**` |\n| \\*escaped\\* | <script>alert(1)</script> |",
          ),
        );
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"] strong').textContent()).toBe("nested");
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"] em').textContent()).toBe("nested");
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"] code').textContent()).toBe("**literal**");
        expect(await page.locator('.k2b-ste-cell[data-r="2"][data-c="0"]').textContent()).toBe("*escaped*");
        expect(await page.locator('.k2b-ste-cell[data-r="2"][data-c="1"]').textContent()).toBe("<script>alert(1)</script>");
      } finally {
        await context.close();
      }
    });
    test("code cells decode table escapes without interpreting their Markdown literals", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("| A | B |\n| --- | --- |\n| `a\\|b` | `a\\\\b` |"));
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"] code').textContent()).toBe("a|b");
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"] code').textContent()).toBe(String.raw`a\b`);
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').textContent()).toBe("`a|b`");
        await page.locator("#after-editor").focus();
        expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"] code').textContent()).toBe("a|b");
      } finally {
        await context.close();
      }
    });
    test("untouched CRLF bytes and escaped pipes survive cell input", async () => {
      const { context, page } = await open();
      try {
        const source = "Before\r\n\r\n| A | B |\r\n| --- | --- |\r\n| one\\|two | 1 |\r\n\r\nAfter";
        await page.evaluate((source) => window.sharedEditorHarness.load(source), source);
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
        await page.keyboard.press("End");
        await page.keyboard.type("2");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(source.replace("| 1 |", "| 12 |"));
      } finally {
        await context.close();
      }
    });
    test("composition into a deleted column is recovered, never written into its neighbour", async () => {
      const { context, page } = await open();
      try {
        const original = "| A | B | C |\n| --- | --- | --- |\n| a | b | c |\n";
        const removed = "| A | C |\n| --- | --- |\n| a | c |\n";
        await page.evaluate((source) => window.sharedEditorHarness.load(source), original);
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
        await page.evaluate(() => {
          const cell = document.activeElement!;
          cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          cell.textContent = "新";
          window.sharedEditorHarness.remoteColumn(1);
          cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "新" }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(removed);
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("recovery:新");
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("cellRemoved");
        expect(await page.locator('.k2b-ste-cell[data-r="1"]').allTextContents()).toEqual(["a", "c"]);
      } finally {
        await context.close();
      }
    });
    test("rejected cell input is recoverable and the visible cell returns to accepted text", async () => {
      const { context, page } = await open();
      try {
        const source = "| A | B |\n| --- | --- |\n| x | y |";
        await page.evaluate((source) => window.sharedEditorHarness.load(source, false, source.length), source);
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.click();
        await page.keyboard.press("End");
        await page.keyboard.type("!");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(source);
        expect(await cell.textContent()).toBe("x");
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("recovery:x!");
      } finally {
        await context.close();
      }
    });
    test("cell focus and typing publish the mapped Markdown selection", async () => {
      const { context, page } = await open();
      try {
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.keyboard.press("End");
        await page.keyboard.type("X");
        await page.waitForFunction(() => window.sharedEditorHarness.caret() === window.sharedEditorHarness.text().indexOf("PaperX") + 6);
        expect(await page.locator(".k2b-ste-cell").first().getAttribute("tabindex")).toBe("-1");
        expect(await page.evaluate(() => window.sharedEditorHarness.cellSelection()?.head)).toBe(
          await page.evaluate(() => window.sharedEditorHarness.caret()),
        );
        await page.locator("#after-editor").focus();
        await page.waitForFunction(() => window.sharedEditorHarness.cellSelection() === null);
      } finally {
        await context.close();
      }
    });
    test("HTML paste keeps word spacing and image-only paste reports an attachment hint", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => {
          window.sharedEditorHarness.load("");
          window.sharedEditorHarness.selection(0);
        });
        await page.locator(".cm-content").evaluate((el) => {
          const data = new DataTransfer();
          data.setData(
            "text/html",
            '<p>Hello<b> bold </b>world <i> italic </i>end</p><p><u style="font-weight:700">Important</u> <font style="font-style:italic">aside</font></p>',
          );
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(
          "Hello **bold** world  *italic* end\n\n**Important** *aside*",
        );
        await page.locator(".cm-content").evaluate((el) => {
          const data = new DataTransfer();
          data.items.add(new File(["fixture"], "image.png", { type: "image/png" }));
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("images:1");
      } finally {
        await context.close();
      }
    });
    test("HTML paste keeps supported content without mounting active elements or resource attributes", async () => {
      const { context, page } = await open();
      const requests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("clipboard.invalid")) requests.push(request.url());
      });
      try {
        const html =
          '<script>document.body.dataset.clipboardExecuted="yes"</script>' +
          '<iframe src="https://clipboard.invalid/frame"></iframe>' +
          '<img src="https://clipboard.invalid/image" onerror="document.body.dataset.clipboardExecuted=1">' +
          '<p><b>Kept</b> <a href="javascript:alert(1)">label</a></p>' +
          "<table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table>";
        await page.evaluate(() => {
          window.sharedEditorHarness.load("");
          window.sharedEditorHarness.selection(0);
        });
        await page.locator(".cm-content").evaluate((el, html) => {
          const data = new DataTransfer();
          data.setData("text/html", html);
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        }, html);
        const text = await page.evaluate(() => window.sharedEditorHarness.text());
        expect(text).toContain("**Kept** label");
        expect(text).toContain("one");
        expect(text).not.toContain("javascript:");
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("images:1");
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.locator(":focus").evaluate(
          (el, html) => {
            const data = new DataTransfer();
            data.setData("text/html", html);
            el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          },
          html.replace("<td>one</td>", "<td>cell-pasted-value</td>"),
        );
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("cell-pasted-value");
        expect(await page.evaluate(() => window.sharedEditorHarness.errors().filter((error) => error === "images:1").length)).toBe(2);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(
          await page
            .locator("#root script, #root iframe, #root img:not(.cm-widgetBuffer), #root [src], #root [srcset], #root [onerror]")
            .evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
        ).toEqual([]);
        expect(await page.locator("body").getAttribute("data-clipboard-executed")).toBeNull();
        expect(requests).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test.skipIf(browserName !== "chromium")("real Chromium IME preserves concurrent cell input", async () => {
      const { context, page } = await open();
      try {
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.keyboard.press("End");
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
        await page.evaluate(() => {
          const from = window.sharedEditorHarness.text().indexOf("Paper");
          window.sharedEditorHarness.remote(from, "REMOTE-");
        });
        await cdp.send("Input.insertText", { text: "日本" });
        const text = await page.evaluate(() => window.sharedEditorHarness.text());
        expect(text).toContain("REMOTE-Paper日本");
        expect(text).not.toContain("にほん");
        await cdp.detach();
      } finally {
        await context.close();
      }
    });
    test("composition preserves a remote replacement of equal length", async () => {
      const { context, page } = await open();
      try {
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.evaluate(() => {
          const cell = document.activeElement!;
          cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          cell.textContent = "新";
          const from = window.sharedEditorHarness.text().indexOf("Paper");
          window.sharedEditorHarness.remote(from, "REMOTE", from + 5);
          cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "新" }));
        });
        const text = await page.evaluate(() => window.sharedEditorHarness.text());
        expect(text).toContain("REMOTE");
        expect(text).toContain("新");
      } finally {
        await context.close();
      }
    });
    test("paste creates a table in one undo step and refuses over-budget cell grids", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => {
          window.sharedEditorHarness.load("Start\n\nEnd");
          window.sharedEditorHarness.selection(7);
        });
        await page.locator(".cm-content").evaluate((el) => {
          const data = new DataTransfer();
          data.setData("text/plain", "Name\tCount\nPaper\t3");
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("| Paper | 3 |");
        await page.keyboard.press(name === "phone" && browserName === "webkit" ? "Meta+z" : "Control+z");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe("Start\n\nEnd");
        await page.locator(".cm-content").evaluate((el) => {
          const data = new DataTransfer();
          data.setData("text/plain", Array(2002).fill("x").join("\t"));
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("pasteTooLarge");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe("Start\n\nEnd");
      } finally {
        await context.close();
      }
    });
    test("source toggle preserves bytes; extra cells stay visible; read-only rejects input", async () => {
      const { context, page } = await open();
      try {
        const source = "| A | B |\n| --- | --- |\n| a | b | EXTRA |\n";
        await page.evaluate((source) => window.sharedEditorHarness.load(source), source);
        expect(await page.locator("[data-extra]").textContent()).toBe("EXTRA");
        await page.evaluate(() => window.sharedEditorHarness.mode("source"));
        expect(await page.locator(".k2b-ste-table").count()).toBe(0);
        await page.evaluate(() => {
          window.sharedEditorHarness.mode("formatted");
          window.sharedEditorHarness.readOnly(true);
        });
        expect(await page.locator(".k2b-ste-cell").first().getAttribute("contenteditable")).toBe("false");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(source);
      } finally {
        await context.close();
      }
    });
    test("Select All in a cell replaces only that cell", async () => {
      const { context, page } = await open();
      try {
        const before = await page.evaluate(() => window.sharedEditorHarness.text());
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"]').click();
        await page.keyboard.press("ControlOrMeta+a");
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("4");
        await page.keyboard.type("12");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(before.replace("| Paper | 4 |", "| Paper | 12 |"));
      } finally {
        await context.close();
      }
    });
    test("extra-cell markers follow header width without changing the grid shape", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.load("| A | B |\n| --- | --- |\n| x | y | EXTRA |"));
        expect(await page.locator("[data-extra]").textContent()).toBe("EXTRA");
        await page.locator(".k2b-ste-cell").first().click();
        await page.evaluate(() => window.sharedEditorHarness.action("completeColumns"));
        expect(await page.locator("[data-extra]").count()).toBe(0);
        expect(await page.locator(".k2b-ste-cell").last().textContent()).toBe("EXTRA");
        await page.evaluate(() => {
          const text = window.sharedEditorHarness.text();
          const body = text.indexOf("\n", text.indexOf("\n") + 1) + 1;
          window.sharedEditorHarness.remote(0, "| A | B |\n| --- | --- |\n", body);
        });
        expect(await page.locator("[data-extra]").textContent()).toBe("EXTRA");
      } finally {
        await context.close();
      }
    });
    test("format commands support three heading levels and preserve prose before a rule", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => {
          window.sharedEditorHarness.load("Paragraph\n");
          window.sharedEditorHarness.selection(10);
          window.sharedEditorHarness.command("rule");
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe("Paragraph\n\n---\n");
        await page.evaluate(() => {
          window.sharedEditorHarness.selection(0);
          window.sharedEditorHarness.command("heading1");
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toStartWith("# Paragraph");
        await page.evaluate(() => window.sharedEditorHarness.command("heading3"));
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toStartWith("### Paragraph");
        await page.evaluate(() => window.sharedEditorHarness.command("heading2"));
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toStartWith("## Paragraph");
      } finally {
        await context.close();
      }
    });
    test("all cell clipboard routes preserve data and enforce table budgets", async () => {
      const { context, page } = await open();
      try {
        const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
        await cell.click();
        await cell.evaluate((el) => {
          const data = new DataTransfer();
          data.setData("text/html", "<TABLE><TR><TD>HTML only</TD></TR></TABLE>");
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("HTML only");
        const before = await page.evaluate(() => window.sharedEditorHarness.text());
        await cell.evaluate((el) => {
          const data = new DataTransfer();
          data.setData("text/plain", "| h |\n| --- |\n" + Array(2001).fill("| x |").join("\n"));
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(before);
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("pasteTooLarge");
        await cell.evaluate((el) => {
          const data = new DataTransfer();
          data.items.add(new File(["fixture"], "image.png", { type: "image/png" }));
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("images:1");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(before);
      } finally {
        await context.close();
      }
    });
    test("arrows and native Tab enter the grid through one cell, respecting Tab-for-focus", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(() => window.sharedEditorHarness.selection(7));
        await page.keyboard.press("ArrowDown");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("0");
        await page.keyboard.press("ArrowUp");
        expect(await page.locator(":focus").getAttribute("class")).toContain("cm-content");
        await page.keyboard.press("Tab");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("0");
        expect(await page.locator('.k2b-ste-cell[tabindex="0"]').count()).toBe(1);
        await page.evaluate(() => window.sharedEditorHarness.tabMovesFocus(true));
        const before = await page.evaluate(() => window.sharedEditorHarness.text());
        await page.keyboard.press("Shift+Tab");
        expect(await page.locator(":focus").getAttribute("class")).toContain("cm-content");
        await page.keyboard.press("Tab");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("0");
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.matches(".k2b-ste-cell"))).toBe(false);
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(before);
      } finally {
        await context.close();
      }
    });
    test("collaborative structure delegates, offline append remains local", async () => {
      const { context, page } = await open();
      try {
        const source = await page.evaluate(() => window.sharedEditorHarness.text());
        await page.evaluate((source) => window.sharedEditorHarness.load(source, true), source);
        await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
        await page.evaluate(() => window.sharedEditorHarness.action("colRight"));
        expect(await page.evaluate(() => window.sharedEditorHarness.calls())).toEqual(["colRight"]);
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(source);
        await context.setOffline(true);
        await page.evaluate(() => window.sharedEditorHarness.action("deleteRow"));
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toContain("structureUnavailable");
        await page.keyboard.press("Enter");
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("2");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toBe(source);
        await page.keyboard.press("Enter");
        expect(await page.locator('.k2b-ste-cell[data-r="3"]').count()).toBe(2);
        expect(await page.locator(":focus").getAttribute("data-r")).toBe("3");
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("\n\nAfter");
      } finally {
        await context.close();
      }
    });
  });
