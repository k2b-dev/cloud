import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../packages/ui/test/browser";
import { build } from "../scripts/build";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: string[];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-slash-"));
  try {
    const outdir = join(directory, "dist");
    await build({ development: false, outdir });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith("/api/")) return Response.json({ code: "unavailable" }, { status: 503 });
        const path = resolve(outdir, `.${decodeURIComponent(pathname)}`);
        if (path !== outdir && !path.startsWith(`${outdir}${sep}`)) return new Response(null, { status: 404 });
        const file = Bun.file(path === outdir ? join(outdir, "index.html") : path);
        return new Response((await file.exists()) ? file : Bun.file(join(outdir, "index.html")), {
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    browser = await launchBrowser();
  } catch (error) {
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}, 60_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const open = async (width = 1280, height = 900, touch = false) => {
  context = await browser.newContext({
    locale: "de-DE",
    viewport: { width, height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  context.setDefaultTimeout(5_000);
  await context.addInitScript(() => {
    if (!localStorage.getItem("k2b-notes.preferences"))
      localStorage.setItem("k2b-notes.preferences", JSON.stringify({ welcomeCreated: true }));
  });
  page = await context.newPage();
  errors = pageErrors(page);
};
beforeEach(() => open());
afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
  }
});

const content = () => page.locator(".cm-content");
const options = () => page.locator(".cm-tooltip-autocomplete li");

/** A note named "Titel" with a free line, once the lazy presentation and its popup sources are ready. */
const newNote = async () => {
  await page.goto(server.url.origin);
  await page.getByRole("textbox", { name: "Neue Notiz", exact: true }).fill("Titel");
  await page.waitForURL(/\/n\/[A-Za-z0-9]{22}$/);
  await content().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
};
const pasteSource = async (text: string) =>
  content().evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
const pick = async (name: string) => {
  await page.keyboard.type(`/${name}`);
  await options().first().waitFor();
  await page.waitForTimeout(100); // CodeMirror ignores accepting a popup in its first moments.
  await page.keyboard.press("Enter");
};
/** The caret leaves the block, so its presentation replaces the source. */
const leave = () => page.locator(".cm-line", { hasText: "Titel" }).first().click();

describe("Notes: slash menu", () => {
  const blocks: [name: string, type: string, selector: string, hidden: string][] = [
    ["quote", "Gesagt", ".k2b-ste-quote", ">"],
    ["list", "Punkt", ".custom-list-marker-bullet", "- "],
    ["numbered", "Punkt", ".custom-list-marker-ordered", "- "],
    ["checkliste", "Punkt", ".custom-list-task-marker", "[ ]"],
    ["code", "const a = 1", ".k2b-ste-codeblock", "```"],
    ["divider", "", ".cm-hr-widget", "---"],
    ["hinweis", "Wichtig", ".cm-notice-card-widget", ":::"],
    ["info", "Wichtig", ".cm-notice-card-widget", ":::"],
    ["success", "Wichtig", ".cm-notice-card-widget", ":::"],
    ["warning", "Wichtig", ".cm-notice-card-widget", ":::"],
    ["danger", "Wichtig", ".cm-notice-card-widget", ":::"],
    ["diagramm", "", ".k2b-chart__svg", ":::"],
    ["balken", "", ".k2b-chart__svg", ":::"],
    ["kreis", "", ".k2b-chart__svg", ":::"],
    ["ring", "", ".k2b-chart__svg", ":::"],
    ["punkte", "", ".k2b-chart__svg", ":::"],
    ["tag", "idee", ".n-tagpill", "\u0000"],
  ];
  for (const [name, type, selector, hidden] of blocks)
    test(`/${name} becomes its rendered block, not source`, async () => {
      await newNote();
      await pick(name);
      if (type) await page.keyboard.type(type);
      await leave();
      await page.locator(selector).first().waitFor();
      expect(await content().innerText()).not.toContain(hidden);
      if (type) expect(await content().innerText()).toContain(type);
      expect(await page.locator(".notebook-book-chart__status").count()).toBe(0);
    }, 15_000);

  for (const [name, size] of [
    ["h1", "# "],
    ["h2", "## "],
    ["h3", "### "],
  ] as const)
    test(`/${name} makes a heading larger than the body`, async () => {
      await newNote();
      await pick(name);
      await page.keyboard.type("Kapitel");
      await leave();
      await settled(page);
      const line = page.locator(".cm-line", { hasText: "Kapitel" });
      expect(await line.innerText()).not.toContain(size.trim());
      const pixels = (element: Element) => Number.parseFloat(getComputedStyle(element.querySelector("span") ?? element).fontSize);
      expect(await line.evaluate(pixels)).toBeGreaterThan(
        await page.locator(".cm-content").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      );
    }, 15_000);

  test("/link inserts at the caret and renders; a divider after text leaves that text alone", async () => {
    await newNote();
    await page.keyboard.type("Siehe ");
    await pick("link");
    await page.keyboard.type("https://example.org");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Absatz /divider");
    await options().first().waitFor();
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await leave();
    await page.locator(".cm-link-widget").waitFor();
    await page.locator(".cm-hr-widget").waitFor();
    expect(await content().innerText()).toContain("Siehe");
  }, 15_000);

  test("/tabelle continues in a cell; /bild takes an image and a PDF", async () => {
    await newNote();
    await pick("tabelle");
    await page.waitForFunction(() => document.activeElement?.matches(".k2b-ste-cell"));
    await page.keyboard.press("ControlOrMeta+End");
    await leave();
    await content().click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick("pdf")]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([
      { name: "punkt.png", mimeType: "image/png", buffer: PNG },
      { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") },
    ]);
    await leave();
    await page.locator(".cm-content img").first().waitFor();
    await page.getByText("plan.pdf").first().waitFor();
  }, 15_000);

  test("selecting a row moves nothing, keeps its icon tile, and the hint stays quieter than the label", async () => {
    await newNote();
    await page.keyboard.type("/");
    await options().first().waitFor();
    const rows = await options().evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
    await page.waitForTimeout(100);
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.querySelectorAll(".cm-tooltip-autocomplete li")[1]?.getAttribute("aria-selected") === "true");
    expect(await options().evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))).toEqual(rows);
    const look = await page.evaluate(() => {
      const luminance = (color: string) => {
        const canvas = document.createElement("canvas").getContext("2d")!;
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = canvas.getImageData(0, 0, 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const row = (index: number) => document.querySelectorAll(".cm-tooltip-autocomplete li")[index]!;
      const selected = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')!;
      const withHint = [...document.querySelectorAll(".cm-tooltip-autocomplete li")].find(
        (item) => item.querySelector(".cm-completion-detail")?.textContent,
      )!;
      return {
        tile: getComputedStyle(selected.querySelector(".cm-slash-icon")!).backgroundColor,
        rowFill: getComputedStyle(selected).backgroundColor,
        plainFill: getComputedStyle(row(0)).backgroundColor,
        label: luminance(getComputedStyle(withHint.querySelector(".cm-completionLabel")!).color),
        hint: luminance(getComputedStyle(withHint.querySelector(".cm-completion-detail")!).color),
      };
    });
    expect(look.tile).not.toBe(look.rowFill);
    expect(look.rowFill).not.toBe(look.plainFill);
    expect(look.hint).toBeGreaterThan(look.label);
  }, 15_000);

  test("rows stay compact with a mouse and at least 44 px tall for a finger", async () => {
    const heights = async () => {
      await newNote();
      await page.keyboard.type("/");
      await options().first().waitFor();
      await settled(page);
      return options().evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    };
    expect(Math.min(...(await heights()))).toBeLessThan(40);
    await context.close();
    await open(390, 844, true);
    expect(Math.min(...(await heights()))).toBeGreaterThanOrEqual(44);
  }, 20_000);

  for (const [width, height] of [
    [1280, 500],
    [390, 500],
  ] as const)
    test(`the whole list scrolls inside the popup at ${width}×${height}`, async () => {
      await context.close();
      await open(width, height);
      await newNote();
      await page.keyboard.type("/");
      await options().first().waitFor();
      const popup = await page.locator(".cm-tooltip-autocomplete").boundingBox();
      if (!popup) throw new Error("No popup");
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width);
      expect(popup.y).toBeGreaterThanOrEqual(0);
      expect(popup.y + popup.height).toBeLessThanOrEqual(height);
      expect(await options().count()).toBe(23);
      // Reaching the last option by keyboard scrolls it into the visible part of the popup.
      await page.waitForTimeout(100);
      for (let index = 0; index < 22; index++) await page.keyboard.press("ArrowDown");
      await settled(page);
      const last = await options().evaluateAll((items) => {
        const selected = items.find((item) => item.getAttribute("aria-selected") === "true")!.getBoundingClientRect();
        const list = items[0]!.parentElement!.getBoundingClientRect();
        return { top: selected.top, bottom: selected.bottom, listTop: list.top, listBottom: list.bottom };
      });
      expect(last.top).toBeGreaterThanOrEqual(last.listTop - 1);
      expect(last.bottom).toBeLessThanOrEqual(last.listBottom + 1);
    }, 15_000);
});

describe("Notes: table formulas", () => {
  const TABLE = "| Monat | Tassen |\n| --- | --- |\n| Juli | 48 |\n| August | 61 |\n| Summe |  |\n\nEnde";
  const cell = () => page.locator('.k2b-ste-cell[data-r="3"][data-c="1"]');
  const tableNote = async () => {
    await newNote();
    await pasteSource(TABLE);
    await page.keyboard.press("ControlOrMeta+End");
    await cell().click();
  };

  test("typing suggests functions and columns; the result stays after leaving and reloading", async () => {
    await tableNote();
    await page.keyboard.type("=SU");
    const sum = page.getByRole("option", { name: /^SUM\s*\(Spalte\)/ });
    await sum.waitFor();
    await page.waitForTimeout(100);
    // SUM is the first suggestion, and the result popover does not cover it.
    expect(await sum.getAttribute("aria-selected")).toBe("true");
    const over = await sum.evaluate((option) => {
      const box = option.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("li") === option;
    });
    expect(over).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("=SUM("));
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Column");
    await page.keyboard.type("Ta");
    await page.getByRole("option", { name: /Tassen/ }).waitFor();
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.textContent === "=SUM(Tassen)");
    // While the caret is in the cell, the result shows right below it.
    await page.locator(".cm-notebook-active-result", { hasText: "109" }).waitFor();
    await leave();
    await cell().locator(".md-formula-ok", { hasText: "109" }).waitFor();
    await page.waitForTimeout(600); // The local store saves after a short pause.
    await page.reload();
    await cell().locator(".md-formula-ok", { hasText: "109" }).waitFor();
    // First paint: no raw formula shows once the grid is there.
    expect(await cell().innerText()).not.toContain("=SUM");
  }, 20_000);

  test("an unknown function and column say what is wrong, in the note's language", async () => {
    await tableNote();
    await page.keyboard.type("=SUMM(Tassen)");
    await page.locator(".cm-notebook-active-result[data-error]", { hasText: "Unbekannte Funktion" }).waitFor();
    await leave();
    const failed = cell().locator(".md-formula-error");
    expect(await failed.getAttribute("title")).toContain("Unbekannte Funktion");
    await cell().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("=SUM(Kaffee)");
    await page.locator(".cm-notebook-active-result[data-error]", { hasText: "Unbekannte Spalte" }).waitFor();
  }, 15_000);

  test("cells without a formula keep their Markdown: bold header, literal escapes", async () => {
    await newNote();
    await pasteSource("| **Name** | Wert |\n| --- | --- |\n| \\*wörtlich\\* | *kursiv* |\n\nEnde");
    await page.keyboard.press("ControlOrMeta+End");
    await page.locator('.k2b-ste-cell[data-r="0"][data-c="0"] strong', { hasText: "Name" }).waitFor();
    expect(await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').innerText()).toBe("*wörtlich*");
    await page.locator('.k2b-ste-cell[data-r="1"][data-c="1"] em', { hasText: "kursiv" }).waitFor();
  }, 15_000);

  test("on a phone the suggestions of a cell at the right stay fully visible", async () => {
    await context.close();
    await open(390, 844);
    await tableNote();
    await page.keyboard.type("=SU");
    await options().first().waitFor();
    await settled(page);
    const popup = page.locator(".cm-tooltip-autocomplete");
    const visible = await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const inside = (x: number) => element.contains(document.elementFromPoint(x, box.top + box.height / 2));
      return box.right <= innerWidth && inside(box.left + 2) && inside(box.right - 2);
    });
    expect(visible).toBe(true);
  }, 15_000);

  test("/ in a cell stays text: no block can split the row", async () => {
    await tableNote();
    await page.keyboard.type("a /");
    await page.waitForTimeout(200);
    expect(await options().count()).toBe(0);
    await page.waitForFunction(() => document.activeElement?.textContent === "a /");
  }, 15_000);
});
