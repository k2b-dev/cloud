/**
 * Notebook on the shared @k2b/ui TextEditor (Gate 5 regression): direct cell editing
 * with formulas, cell keys, toolbar and menu, F3 A server actions, paste, undo next to
 * another person, captions, and the Notebook paths that existed before the grid.
 * Builds shared UI entry points from source so a stale dist cannot mask a regression.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, type Page, devices as playwrightDevices } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
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

const { defaultBrowserType: _, ...phone } = playwrightDevices[browserName === "webkit" ? "iPhone 15" : "Pixel 7"];
const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 860 } };

const open = async (options: { doc?: string; device?: BrowserContextOptions } = {}) => {
  const context = await browser.newContext(options.device ?? desktop);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const url = new URL(server.url.href);
  if (options.doc) url.searchParams.set("doc", options.doc);
  await page.goto(url.href);
  await page.waitForFunction(() => "noteHarness" in window && !!document.querySelector(".cm-content"));
  return {
    page,
    errors,
    close: async () => {
      await context.close();
      expect(errors).toEqual([]);
    },
  };
};

const cell = (page: Page, row: number, column: number) => page.locator(`.k2b-ste-cell[data-r="${row}"][data-c="${column}"]`);
const toolbarButton = (page: Page, name: string) => page.locator(".notebooks-editor-toolbar").getByRole("button", { name, exact: true });
const text = (page: Page) => page.evaluate(() => window.noteHarness.text());
const waitForText = async (page: Page, expected: string) => {
  try {
    await page.waitForFunction((value) => window.noteHarness.text().includes(value), expected, { timeout: 1_000 });
  } catch (cause) {
    throw new Error(`Expected document to contain ${JSON.stringify(expected)}; received ${JSON.stringify(await text(page))}`, { cause });
  }
};
const activeCell = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches(".k2b-ste-cell") ? `${active.dataset.r},${active.dataset.c}` : null;
  });
const notice = (page: Page) => page.locator(".k2b-ste-notice");
const checkAlignmentGlyphs = async (page: Page) => {
  const glyphs = await page.locator(".k2b-ste-align-choice:visible > i:not(.k2b-dropdown__check)").evaluateAll((icons) =>
    icons.map((icon) => {
      const style = getComputedStyle(icon);
      const content = getComputedStyle(icon, "::before").content;
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        icon.getBoundingClientRect().width > 0 &&
        content !== "none" &&
        content !== "normal" &&
        content !== '""'
      );
    }),
  );
  expect(glyphs).toEqual([true, true, true]);
};

describe("Notebook on the shared text editor", () => {
  test("edits a formula table directly and keeps evaluated results, captions and unchanged source", async () => {
    const { page, errors, close } = await open();
    try {
      expect(await cell(page, 1, 2).textContent()).toContain("100");
      // One editable caption: the @handle stays source text, with no second rendered caption.
      expect(await page.locator(".cm-notebook-table-caption").count()).toBe(1);
      expect(await page.locator(".cm-notebook-table-caption").textContent()).toBe("@costs");

      const before = await text(page);
      await cell(page, 1, 1).click();
      expect(await activeCell(page)).toBe("1,1");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("4");
      await waitForText(page, "| Design | 4 |");
      expect(await text(page)).toBe(before.replace("| Design | 2 |", "| Design | 4 |"));
      // The dependent formula cell refreshes while its source stays the formula.
      await page.waitForFunction(() => document.querySelector('.k2b-ste-cell[data-r="1"][data-c="2"]')?.textContent?.includes("200"));
      expect(await text(page)).toContain("=Hours*50");

      // The active formula cell shows its source; leaving it shows the result again.
      await cell(page, 1, 2).click();
      expect(await cell(page, 1, 2).textContent()).toBe("=Hours*50");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector('.k2b-ste-cell[data-r="1"][data-c="2"]')?.textContent?.includes("200"));
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("Tab, Shift+Tab and Enter move and append rows; appending works offline and is one undo step", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.setOnline(false));
      await cell(page, 1, 0).click();
      await page.keyboard.press("Tab");
      expect(await activeCell(page)).toBe("1,1");
      await page.keyboard.press("Shift+Tab");
      expect(await activeCell(page)).toBe("1,0");
      await cell(page, 2, 2).click();
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => document.querySelectorAll(".k2b-ste-table tr").length === 4);
      expect(await activeCell(page)).toBe("3,0");
      await page.keyboard.type("Test");
      await waitForText(page, "| Test  |");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll(".k2b-ste-table tr").length === 5);
      expect(await activeCell(page)).toBe("4,0");
      await page.keyboard.press("ControlOrMeta+z");
      await page.waitForFunction(() => document.querySelectorAll(".k2b-ste-table tr").length === 4);
      expect(await text(page)).toContain("| Test  |");
    } finally {
      await close();
    }
  });

  test("participant colour is interpreted only as a colour", async () => {
    const { page, close } = await open();
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("presence.invalid")) requests.push(request.url());
    });
    try {
      await page.evaluate(() => window.noteHarness.peerCursor("Design", 'url("https://presence.invalid/image")'));
      const marked = page.locator('.k2b-ste-table [data-peer="Paul"]');
      await marked.waitFor();
      expect(await marked.evaluate((element) => getComputedStyle(element, "::after").backgroundImage)).toBe("none");
      expect(requests).toEqual([]);
    } finally {
      await close();
    }
  });

  test("search opened from a cell marks matching cells and keeps the document unchanged", async () => {
    const { page, close } = await open();
    try {
      const before = await text(page);
      await cell(page, 1, 0).click();
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.locator('.cm-search input[name="search"]');
      await search.pressSequentially("Design");
      await page.waitForFunction(() =>
        document.querySelector('.k2b-ste-cell[data-r="1"][data-c="0"]')?.parentElement?.classList.contains("cm-searchMatch"),
      );
      await page.locator('.cm-search button[name="close"]').click();
      await page.waitForFunction(() => !document.querySelector(".k2b-ste-table .cm-searchMatch"));
      expect(await text(page)).toBe(before);
    } finally {
      await close();
    }
  });

  test("Notebook inline shortcuts and highlighting keep working inside cells", async () => {
    const { page, close } = await open();
    try {
      await cell(page, 1, 0).click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("ControlOrMeta+Shift+h");
      await waitForText(page, "| ==Design== |");
      expect(await activeCell(page)).toBe("1,0");
      await toolbarButton(page, "Highlight").click();
      await waitForText(page, "| Design |");
      await page.keyboard.press("ControlOrMeta+e");
      await waitForText(page, "| `Design` |");
      await page.keyboard.press("ControlOrMeta+e");
      await waitForText(page, "| Design |");
      await page.keyboard.press("ControlOrMeta+Shift+s");
      await waitForText(page, "| ~~Design~~ |");
      expect(await activeCell(page)).toBe("1,0");
    } finally {
      await close();
    }
  });

  test("the Notebook toolbar formats the focused cell, keeps block formats out and opens the shared cell menu", async () => {
    const { page, close } = await open();
    try {
      await cell(page, 1, 0).click();
      await page.keyboard.press("ControlOrMeta+a");
      await toolbarButton(page, "Bold").click();
      await waitForText(page, "| **Design** |");
      expect(await activeCell(page)).toBe("1,0");
      for (const name of ["Bullet list", "Checklist"]) expect(await toolbarButton(page, name).getAttribute("aria-disabled")).toBe("true");
      // The insert-table button turns into the shared table menu at the same place.
      expect(await toolbarButton(page, "Insert table").count()).toBe(0);
      await toolbarButton(page, "Edit table").click();
      for (const item of ["Row above", "Row below", "Column left", "Column right", "Delete row", "Delete column"])
        expect(await page.getByRole("menuitem", { name: new RegExp(`^${item}(?:\\s*Enter)?$`) }).isVisible()).toBe(true);
      await checkAlignmentGlyphs(page);
      const menuWidth = await page.locator(".k2b-ste-table-menu:visible").evaluate((element) => ({
        actual: element.getBoundingClientRect().width,
        expected: 18 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      }));
      expect(Math.abs(menuWidth.actual - menuWidth.expected)).toBeLessThan(1);
      await page.keyboard.press("Escape");
      expect(await activeCell(page)).toBe("1,0");
      // Outside the table the old insert path is back.
      await page.evaluate(() => window.noteHarness.placeCaret("After the table.", 0));
      await toolbarButton(page, "Insert table").waitFor();
    } finally {
      await close();
    }
  });

  test("a column action runs on the server, arrives through the stream and is one undo step", async () => {
    const { page, close } = await open();
    try {
      const before = await text(page);
      await cell(page, 1, 1).click();
      await toolbarButton(page, "Edit table").click();
      await page.getByRole("menuitem", { name: "Column right", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.k2b-ste-table tr:first-child [data-c="3"]').length === 1);
      expect(await page.evaluate(() => window.noteHarness.posts())).toBe(1);
      expect(await text(page)).toContain("| --- | ---: | --- | ---: |");
      // Formulas still evaluate against their columns by name.
      expect(await cell(page, 1, 3).textContent()).toContain("100");
      await page.evaluate(() => window.noteHarness.undo());
      await page.waitForFunction((value) => window.noteHarness.text() === value, before);
    } finally {
      await close();
    }
  });

  test("offline, unsent or pending state blocks server actions; only appending a row stays available", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.setOnline(false));
      await cell(page, 2, 1).click();
      await toolbarButton(page, "Edit table").click();
      expect(await page.getByRole("menuitem", { name: "Column right", exact: true }).getAttribute("aria-disabled")).toBe("true");
      expect(await page.getByRole("menuitem", { name: "Delete row" }).getAttribute("aria-disabled")).toBe("true");
      expect(await page.getByRole("menuitem", { name: "Row below" }).getAttribute("aria-disabled")).not.toBe("true");
      expect(await page.getByRole("menu", { name: "Edit table" }).getByText("Reconnect to insert in the middle").isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      // Reconnecting re-enables the menu without another document change.
      await page.evaluate(() => window.noteHarness.setOnline(true));
      await toolbarButton(page, "Edit table").click();
      expect(await page.getByRole("menuitem", { name: "Column right", exact: true }).getAttribute("aria-disabled")).not.toBe("true");
      expect(await page.evaluate(() => window.noteHarness.posts())).toBe(0);
    } finally {
      await close();
    }
  });

  test("a rejection shows the server's reason; an unknown outcome waits visibly and is never resent", async () => {
    const { page, close } = await open();
    try {
      const before = await text(page);
      await page.evaluate(() => window.noteHarness.setServer("reject"));
      await cell(page, 1, 1).click();
      await toolbarButton(page, "Edit table").click();
      await page.getByRole("menuitem", { name: "Delete column" }).click();
      await notice(page).getByText("The table changed. Check it and try again.").waitFor();
      expect(await text(page)).toBe(before);
      await notice(page).getByRole("button", { name: "Dismiss" }).click();

      await page.evaluate(() => window.noteHarness.setServer("unknown"));
      await cell(page, 1, 1).click();
      await toolbarButton(page, "Edit table").click();
      await page.getByRole("menuitem", { name: "Column left", exact: true }).click();
      await page.getByText("Table change not confirmed yet").waitFor();
      await cell(page, 1, 1).click();
      await toolbarButton(page, "Edit table").click();
      expect(await page.getByRole("menuitem", { name: "Column left", exact: true }).getAttribute("aria-disabled")).toBe("true");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Stop waiting" }).click();
      await page.getByText("Table change not confirmed yet").waitFor({ state: "detached" });
      expect(await page.evaluate(() => window.noteHarness.posts())).toBe(2);
      expect(await text(page)).toBe(before);
    } finally {
      await close();
    }
  });

  test("an accepted action whose saving failed still arrives through the stream and says so", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.setServer("accepted-failure"));
      await cell(page, 1, 1).click();
      await toolbarButton(page, "Edit table").click();
      await page.getByRole("menuitemradio", { name: "Right", exact: true }).click();
      await notice(page).getByText("Saved later.").waitFor();
      expect(await page.evaluate(() => window.noteHarness.posts())).toBe(1);
    } finally {
      await close();
    }
  });

  test("spreadsheet cells fill the grid without losing formulas in other columns", async () => {
    const { page, close } = await open();
    try {
      await cell(page, 1, 0).click();
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text/plain", "Paper\t5\nInk\t6");
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await waitForText(page, "| Paper | 5 |");
      expect(await text(page)).toContain("| Ink | 6 |");
      expect(await text(page)).toContain("=Hours*50");
    } finally {
      await close();
    }
  });

  test("clipboard images upload once and images without a file get the hint", async () => {
    const { page, close } = await open({ doc: "After the table." });
    try {
      await page.evaluate(() => window.noteHarness.placeCaret("After the table.", 0));
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      expect(await page.evaluate(() => window.noteHarness.uploads())).toEqual(["shot.png"]);
      expect(await notice(page).count()).toBe(0);

      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text/html", '<p>Logo <img src="https://example.invalid/logo.png"></p>');
        data.setData("text/plain", "Logo");
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await notice(page).getByText("Add images as attachments").waitFor();
      expect(await page.evaluate(() => window.noteHarness.uploads())).toEqual(["shot.png"]);
    } finally {
      await close();
    }
  });

  // Preserve the existing Notebook plain-text paste behavior inside code.
  test("code copied from an editor keeps its lines and indentation", async () => {
    const { page, close } = await open({ doc: "```python\n\n```" });
    try {
      await page.evaluate(() => window.noteHarness.setRich(false));
      await page.evaluate(() => window.noteHarness.placeCaret("```python\n", "```python\n".length));
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData(
          "text/html",
          '<div style="white-space: pre;"><div><span>def</span><span> f():</span></div><div><span>    return 1</span></div></div>',
        );
        data.setData("text/plain", "def f():\n    return 1");
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      expect(await text(page)).toBe("```python\ndef f():\n    return 1\n```");
    } finally {
      await close();
    }
  });

  test("undo removes only my own cell text, never another person's", async () => {
    const { page, close } = await open();
    try {
      await cell(page, 1, 0).click();
      await page.keyboard.press("End");
      await page.keyboard.type("X");
      await waitForText(page, "| DesignX |");
      await page.evaluate(() => window.noteHarness.peerType("| Build", "PEER"));
      await waitForText(page, "| BuildPEER |");
      await page.keyboard.press("ControlOrMeta+z");
      await waitForText(page, "| Design |");
      expect(await text(page)).toContain("| BuildPEER |");
      expect(await cell(page, 2, 0).textContent()).toContain("BuildPEER");
    } finally {
      await close();
    }
  });

  test("another person's caret marks their cell with their name and color", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.peerCursor("Build"));
      await page.waitForFunction(() => document.querySelector('td[data-peer="Paul"] .k2b-ste-cell[data-r="2"][data-c="0"]') !== null);
      await page.evaluate(() => window.noteHarness.peerType("| Design", "!"));
      await page.waitForFunction(() => document.querySelector('td[data-peer="Paul"] .k2b-ste-cell[data-r="2"][data-c="0"]') !== null);
    } finally {
      await close();
    }
  });

  test("Markdown shows raw tables with formula results and line numbers; switching back restores the grid", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.setRich(false));
      await page.waitForFunction(() => !document.querySelector(".k2b-ste-table"));
      expect(await page.locator(".cm-lineNumbers").count()).toBe(1);
      expect(await page.locator(".cm-formula-preview").first().textContent()).toContain("100");
      await page.evaluate(() => window.noteHarness.setRich(true));
      await page.locator(".k2b-ste-table").waitFor();
      expect(await page.locator(".cm-formula-preview").count()).toBe(0);
    } finally {
      await close();
    }
  });

  test("inserting a table continues in its first header cell; formula and column completions stay in the cell", async () => {
    const { page, close } = await open({ doc: "Intro" });
    try {
      await page.evaluate(() => window.noteHarness.placeCaret("Intro", 5));
      await page.evaluate(() => window.noteHarness.insertTable(2, 2));
      await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="0"][data-c="0"]'));
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Header 1");
      await page.keyboard.type("Hours");
      await waitForText(page, "| Hours |");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.type("=SU");
      const sum = page.getByRole("option", { name: /^SUM\s*\(column\)/ });
      await sum.waitFor();
      expect(await sum.locator(".cm-slash-icon").getAttribute("aria-hidden")).toBe("true");
      await page.waitForTimeout(100);
      for (let index = 0; index < (await page.getByRole("option").count()) && (await sum.getAttribute("aria-selected")) !== "true"; index++)
        await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await waitForText(page, "=SUM(");
      expect(await activeCell(page)).toBe("1,1");
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Column");
      await page.keyboard.type("Ho");
      await page.getByRole("option", { name: /Hours/ }).waitFor();
      await page.waitForTimeout(100);
      await page.keyboard.press("Enter");
      await waitForText(page, "=SUM(Hours)");
      expect(await page.locator(".k2b-ste-notice").count()).toBe(0);
    } finally {
      await close();
    }
  });

  test("old prose paths keep working: shortcuts, toolbar marks and undo outside tables", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.placeCaret("After the table.", 0));
      await page.keyboard.press("Shift+End");
      await page.keyboard.press("ControlOrMeta+b");
      await waitForText(page, "**After the table.**");
      await page.keyboard.press("ControlOrMeta+z");
      await page.waitForFunction(() => !window.noteHarness.text().includes("**After"));
      await page.evaluate(() => window.noteHarness.placeCaret("After the table.", 0));
      await page.keyboard.press("Shift+End");
      await toolbarButton(page, "Strikethrough").click();
      await waitForText(page, "~~After the table.~~");
    } finally {
      await close();
    }
  });

  test("read-only keeps the rendered table and formula results without editable cells", async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(() => window.noteHarness.setReadOnly(true));
      await page.waitForFunction(() => document.querySelector(".k2b-ste-table")?.getAttribute("data-readonly") === "1");
      expect(await cell(page, 1, 2).getAttribute("contenteditable")).toBe("false");
      expect(await cell(page, 1, 2).textContent()).toContain("100");
    } finally {
      await close();
    }
  });

  test("phone context-menu event opens the shared sheet after cell focus", async () => {
    const { page, errors, close } = await open({ device: { viewport: { width: 390, height: 844 } } });
    try {
      await cell(page, 1, 0).dispatchEvent("contextmenu", { button: 2, bubbles: true });
      try {
        await page.locator(".k2b-gesture-menu__sheet-menu").waitFor({ timeout: 1_000 });
      } catch (cause) {
        throw new Error(
          `No phone sheet: errors=${JSON.stringify(errors)}; triggers=${await page.locator(".k2b-ste-table-tool, .k2b-ste-cell-menu").evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join("\n"))}; dialogs=${await page.locator("dialog").evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join("\n"))}`,
          { cause },
        );
      }
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("on a phone the toolbar's table button opens the cell menu as a sheet", async () => {
    const { page, close } = await open({ device: { ...phone, viewport: { width: 390, height: 844 } } });
    try {
      await cell(page, 1, 1).tap();
      await toolbarButton(page, "Edit table").tap();
      await page.locator(".k2b-gesture-menu__sheet-menu").getByRole("menuitem", { name: "Row below" }).waitFor();
      expect(
        await page.locator(".k2b-gesture-menu__sheet-menu").getByRole("menuitem", { name: "Column right", exact: true }).isVisible(),
      ).toBe(true);
    } finally {
      await close();
    }
  });
  test("approved WAVE1 Enter goes down, appends once and leaves an empty final row", async () => {
    const { page, close } = await open();
    try {
      const before = await text(page);
      await cell(page, 1, 1).click();
      await page.keyboard.press("Enter");
      expect(await activeCell(page)).toBe("2,1");
      expect(await text(page)).toBe(before);
      await page.keyboard.press("Enter");
      expect(await activeCell(page)).toBe("3,1");
      await page.keyboard.press("Enter");
      expect(await activeCell(page)).toBeNull();
      await page.waitForFunction((before) => window.noteHarness.text() === before, before);
      await cell(page, 1, 0).click();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("2");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("7");
      await waitForText(page, "| Design | 7 |");
      expect(await page.locator('.k2b-ste-table .k2b-ste-cell[tabindex="0"]').count()).toBe(1);
    } finally {
      await close();
    }
  });

  test("approved WAVE1 active formula keeps a live result without moving following prose", async () => {
    const { page, errors, close } = await open();
    try {
      const prose = page.getByText("After the table.", { exact: true });
      const top = await prose.evaluate((element) => element.getBoundingClientRect().top);
      await cell(page, 1, 2).click();
      const result = page.locator(".cm-notebook-active-result");
      await result.waitFor();
      expect(await result.textContent()).toContain("100");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("=Hours*75");
      await page.waitForFunction(() => document.querySelector(".cm-notebook-active-result")?.textContent?.includes("150"));
      expect(await prose.evaluate((element) => element.getBoundingClientRect().top)).toBe(top);
      expect(await activeCell(page)).toBe("1,2");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("approved WAVE1 right-click and grips use identical menus, including local Markdown", async () => {
    const { page, errors, close } = await open();
    try {
      await cell(page, 1, 0).click({ button: "right" });
      const entries = page.locator('[role="menu"]:visible [role^="menuitem"]');
      await entries.first().waitFor();
      const labels = await entries.allTextContents();
      expect(labels.some((label) => label.includes("Edit as Markdown"))).toBe(true);
      const menuWidth = await page.locator('[role="menu"]:visible').evaluate((element) => element.getBoundingClientRect().width);
      const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(menuWidth).toBe(18 * rem);
      await page.keyboard.press("Escape");
      await page.locator(".k2b-ste-rowMenu").nth(1).click();
      await entries.first().waitFor();
      expect(await entries.allTextContents()).toEqual(labels);
      expect(await page.locator('[role="menu"]:visible').evaluate((element) => element.getBoundingClientRect().width)).toBe(menuWidth);
      await page.keyboard.press("Escape");
      await page.locator(".k2b-ste-columnMenu").first().click();
      await entries.first().waitFor();
      expect(await entries.allTextContents()).toEqual(labels);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("approved WAVE1 local Markdown keeps layout and recovers an invalid or structural draft", async () => {
    const { page, errors, close } = await open();
    try {
      await cell(page, 1, 0).click();
      const before = await text(page);
      const proseTop = await page.getByText("After the table.", { exact: true }).evaluate((element) => element.getBoundingClientRect().top);
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", { name: "Edit as Markdown", exact: true }).click();
      const source = page.locator(".k2b-ste-table-source .cm-content");
      await source.waitFor();
      expect(await page.getByText("After the table.", { exact: true }).evaluate((element) => element.getBoundingClientRect().top)).toBe(
        proseTop,
      );
      await source.fill("broken draft");
      await page.getByRole("button", { name: "Show as table", exact: true }).click();
      await page.locator(".k2b-ste-source-error").waitFor();
      expect(await text(page)).toBe(before);
      expect(await source.textContent()).toBe("broken draft");
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      expect(await page.locator(".k2b-ste-table-source").count()).toBe(0);
      expect(await text(page)).toBe(before);
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", { name: "Edit as Markdown", exact: true }).click();
      // Cell edits commit through the ordinary binding; no structural bypass.
      await source.evaluate((element) => {
        const selection = document.getSelection()!;
        const range = document.createRange();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent?.indexOf("Design") ?? -1;
          if (at < 0) continue;
          range.setStart(node, at);
          range.setEnd(node, at + 6);
          selection.removeAllRanges();
          selection.addRange(range);
          break;
        }
      });
      await page.keyboard.type("Planning");
      await page.getByRole("button", { name: "Show as table", exact: true }).click();
      await waitForText(page, "| Planning |");
      expect(await page.locator(".k2b-ste-table-source").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("approved WAVE1 wide tables freeze their first column and phone adds reserve space", async () => {
    const headers = Array.from({ length: 8 }, (_, index) => `Column ${index + 1}`).join(" | ");
    const doc = `| ${headers} |\n| ${Array.from({ length: 8 }, () => "---").join(" | ")} |\n| ${headers} |\n\nAfter`;
    const { page, close } = await open({ doc, device: { ...phone, viewport: { width: 390, height: 844 } } });
    try {
      const wrap = page.locator(".k2b-ste-table");
      const top = await page.getByText("After", { exact: true }).evaluate((element) => element.getBoundingClientRect().top);
      await cell(page, 1, 0).tap();
      expect(await page.getByRole("button", { name: "+ Row", exact: true }).isVisible()).toBe(true);
      expect(await page.getByText("After", { exact: true }).evaluate((element) => element.getBoundingClientRect().top)).toBe(top);
      const start = await cell(page, 1, 0).evaluate((element) => element.getBoundingClientRect().left);
      await wrap.evaluate((element) => {
        element.scrollLeft = 260;
      });
      expect(Math.abs((await cell(page, 1, 0).evaluate((element) => element.getBoundingClientRect().left)) - start)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await toolbarButton(page, "Table").tap();
      const item = page.locator(".k2b-gesture-menu__sheet-menu").getByRole("menuitem", { name: "Row below" });
      await item.waitFor();
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await checkAlignmentGlyphs(page);
      const frame = page.locator(".k2b-bottom-sheet-frame:has(.k2b-ste-align-choice)");
      const bounds = await frame.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) * 0.62 + 1);
      const targets = await page
        .locator(".k2b-gesture-menu__sheet-menu [role^=menuitem]")
        .evaluateAll((items) => items.map((element) => element.getBoundingClientRect().height >= 44));
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.every(Boolean)).toBe(true);
      const activeBounds = await cell(page, 1, 0).boundingBox();
      expect(activeBounds!.y + activeBounds!.height).toBeLessThanOrEqual(bounds!.y + 1);
      const done = frame.getByRole("button", { name: "Done", exact: true });
      expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await done.tap();
      await frame.waitFor({ state: "detached" });
      expect(await text(page)).toBe(doc);
      expect(await activeCell(page)).toBe("1,0");
    } finally {
      await close();
    }
  });

  for (const outcome of ["apply", "reject", "unknown"] as const) {
    test(`structural Markdown ${outcome} preserves drafts until a confirmed server outcome`, async () => {
      const initial = "| Item |\n| --- |\n| Paper |";
      const replacement = "| Item | Price |\n| --- | ---: |\n| Paper | 4 |";
      const { page, errors, close } = await open({ doc: initial });
      try {
        if (outcome !== "apply") await page.evaluate((mode) => window.noteHarness.setServer(mode), outcome);
        await cell(page, 1, 0).click();
        await page.keyboard.press("Shift+F10");
        await page.getByRole("menuitem", { name: "Edit as Markdown", exact: true }).click();
        const draft = page.locator(".k2b-ste-table-source .cm-content");
        await draft.fill(replacement);
        await page.getByRole("button", { name: "Show as table", exact: true }).click();
        if (outcome === "apply") {
          await draft.waitFor({ state: "detached" });
          expect(await text(page)).toBe(replacement);
          expect(await cell(page, 1, 1).textContent()).toBe("4");
          // fill leaves the draft caret in its last cell; receipt follows it.
          expect(await activeCell(page)).toBe("1,1");
          await page.keyboard.press("ControlOrMeta+z");
          await page.waitForFunction((value) => window.noteHarness.text() === value, initial);
          // Source replacement captures the original table's header witness.
          expect(await activeCell(page)).toBe("0,0");
          expect(await cell(page, 0, 0).textContent()).toBe("Item");
          expect(await cell(page, 1, 0).textContent()).toBe("Paper");
        } else {
          if (outcome === "unknown") {
            await page.getByRole("button", { name: "Stop waiting", exact: true }).click();
          }
          await page.locator(".k2b-ste-source-error:not([hidden])").waitFor();
          expect(await draft.textContent()).toContain("Price");
          expect(await draft.getAttribute("contenteditable")).toBe("true");
          expect(await text(page)).toBe(initial);
        }
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  test("approved WAVE1 interrupted Markdown stays copyable across island disposal until explicitly discarded", async () => {
    const { page, errors, close } = await open();
    try {
      await cell(page, 1, 0).click();
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", { name: "Edit as Markdown", exact: true }).click();
      await page.locator(".k2b-ste-table-source .cm-content").fill("unfinished local draft");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("ssr:island-dispose"));
        window.noteHarness.dispose();
      });
      const recovery = page.locator(".k2b-ste-recovery");
      await recovery.waitFor();
      expect(await recovery.inputValue()).toBe("unfinished local draft");
      await page.keyboard.press("Escape");
      expect(await recovery.isVisible()).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event("ssr:island-dispose")));
      await recovery.waitFor();
      expect(await recovery.inputValue()).toBe("unfinished local draft");
      await page.getByRole("button", { name: "Discard preserved input", exact: true }).click();
      await recovery.waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  for (const [deviceName, device] of [
    ["desktop", desktop],
    ["phone", { ...phone, viewport: { width: 390, height: 844 } }],
  ] as const) {
    test(`approved WAVE1 shared table picker has its grid or size sheet on ${deviceName}`, async () => {
      const { page, errors, close } = await open({ doc: "Intro", device });
      try {
        await page.evaluate(() => window.noteHarness.placeCaret("Intro", 5));
        await toolbarButton(page, "Insert table").click();
        if (device === desktop) {
          const picker = page.locator(".k2b-ste-size-popover:popover-open");
          await picker.waitFor();
          await picker.getByRole("button", { name: "Insert 2 × 4", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".k2b-ste-table tr").length === 3);
          expect(await page.locator(".k2b-ste-table th").count()).toBe(4);
        } else {
          await page.getByRole("button", { name: "Insert 3 × 3", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".k2b-ste-table tr").length === 4);
          expect(await page.locator(".k2b-ste-table th").count()).toBe(3);
        }
        expect(await activeCell(page)).toBe("0,0");
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Header 1");
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  for (const entry of ["slash", "slash-de", "more"] as const) {
    for (const [deviceName, device] of [
      ["desktop", desktop],
      ["phone", { ...phone, viewport: { width: 390, height: 844 } }],
    ] as const) {
      test(`approved WAVE1 ${entry} opens the shared size picker on ${deviceName}`, async () => {
        const { page, errors, close } = await open({ doc: "Intro", device });
        try {
          await page.evaluate(() => window.noteHarness.placeCaret("Intro", 5));
          if (entry !== "more") {
            await page.keyboard.press("Enter");
            await page.keyboard.type(entry === "slash-de" ? "/tabelle" : "/table");
            // Pick the actual suggestion. CodeMirror deliberately ignores Enter
            // for 75 ms after opening; a synthetic immediate key would insert a
            // newline before a person could read the suggestion.
            const suggestion = page.locator(".cm-tooltip-autocomplete [role=option]").first();
            try {
              expect(await suggestion.textContent({ timeout: 1_000 })).toContain("Table");
            } catch (cause) {
              throw new Error(
                `Missing ${entry} suggestion on ${deviceName}: doc=${JSON.stringify(await text(page))}; active=${await page.evaluate(() => document.activeElement?.outerHTML)}; errors=${JSON.stringify(errors)}`,
                { cause },
              );
            }
            if (deviceName === "desktop") {
              const box = await suggestion.boundingBox();
              if (!box) throw new Error("The slash suggestion has no pointer target");
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              // Accepting on mousedown removes the trigger. Opening another
              // popover must wait for release, or WebKit dismisses it at once.
              expect(await text(page)).toBe("Intro\n");
              expect(await page.locator(".k2b-ste-size-popover:popover-open").count()).toBe(0);
              await page.mouse.up();
            } else await suggestion.click();
          } else {
            await toolbarButton(page, "More").click();
            await page.getByRole("menuitem", { name: "Table", exact: true }).click();
          }
          const picker =
            device === desktop
              ? page.locator(".k2b-ste-size-popover:popover-open")
              : page.getByRole("dialog", { name: "Insert table", exact: true });
          try {
            await picker.waitFor({ timeout: 1_000 });
          } catch (cause) {
            throw new Error(
              `Picker ${entry} did not open; doc=${JSON.stringify(await text(page))}; errors=${JSON.stringify(errors)}; options=${JSON.stringify(await page.locator(".cm-tooltip-autocomplete").allTextContents())}`,
              { cause },
            );
          }
          await picker.getByRole("button", { name: "Insert 3 × 3", exact: true }).click();
          await cell(page, 0, 0).waitFor();
          expect(await text(page)).not.toMatch(/\/(table|tabelle)/);
          expect(await activeCell(page)).toBe("0,0");
          expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Header 1");
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }

  test("keyboard-picked slash commands open the same size picker", async () => {
    const { page, close } = await open({ doc: "Intro" });
    try {
      await page.evaluate(() => window.noteHarness.placeCaret("Intro", 5));
      await page.keyboard.press("Enter");
      await page.keyboard.type("/table");
      const suggestion = page.getByRole("option").first();
      await suggestion.waitFor();
      // The normal completion interaction delay also applies to keyboard use.
      await page.waitForTimeout(100);
      await page.keyboard.press("Enter");
      const picker = page.locator(".k2b-ste-size-popover:popover-open");
      await picker.waitFor();
      await page.keyboard.press("Enter");
      await cell(page, 0, 0).waitFor();
      expect(await activeCell(page)).toBe("0,0");
      expect(await text(page)).not.toContain("/table");
    } finally {
      await close();
    }
  });

  test("approved WAVE1 phone picker cannot insert after the note becomes read-only", async () => {
    const { page, close } = await open({ doc: "Intro", device: { ...phone, viewport: { width: 390, height: 844 } } });
    try {
      await page.evaluate(() => window.noteHarness.placeCaret("Intro", 5));
      await toolbarButton(page, "Insert table").click();
      await page.getByRole("button", { name: "Insert 3 × 3", exact: true }).waitFor();
      await page.evaluate(() => window.noteHarness.setReadOnly(true));
      await page.getByRole("button", { name: "Insert 3 × 3", exact: true }).click();
      expect(await text(page)).toBe("Intro");
      expect(await page.locator(".k2b-ste-table").count()).toBe(0);
    } finally {
      await close();
    }
  });
});
