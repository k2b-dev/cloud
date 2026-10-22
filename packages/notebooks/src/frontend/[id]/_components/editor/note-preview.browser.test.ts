import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { toJSON } from "seroval";
import type { ComponentProps } from "solid-js";
import { createComponent, renderToString } from "solid-js/web";
import * as Y from "yjs";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";
import { notebooksYjs } from "../../../../lib/yjs";
import type NoteEditor from "./NoteEditor.client";
import "../detail/ssr-test-plugin";
import { NOTE_PREVIEW_BUDGET, NOTE_PREVIEW_ID, notePreviewChart, notePreviewLines } from "./note-preview";

const { default: NotePreview } = await import("./NotePreview");

const markdown = [
  "# Wochenplan",
  "",
  "Wir sammeln **wichtige** Gedanken für das Team und besprechen *offene Fragen* mit allen Beteiligten. Der Befehl `cld notes list` hält die Informationen griffbereit, während wir gemeinsam die nächste Woche planen und unsere Erfahrungen aus dem letzten Projekt für alle festhalten.",
  "",
  "## Nächste Schritte",
  "",
  "Wir halten die Ergebnisse und Entscheidungen für alle fest.",
  "",
  "```js",
  "const team = await notes.list();",
  "const count = team.length;",
  "```",
  "",
  "- a list item",
].join("\n");
const headingMarkdown = markdown.replace(
  "## Nächste Schritte",
  "## Nächste Schritte mit `code` **bold** und *italic*\n\n### `Code heading`\n\nSetext **heading**\n================",
);
const snapshot = (text: string) => {
  const doc = new Y.Doc();
  doc.getText("codemirror").insert(0, text);
  const result = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return result;
};
// Long enough to scroll at every viewport; each line wraps on a phone.
const longMarkdown = Array.from(
  { length: 120 },
  (_, index) => `Zeile ${index + 1}: Wir sammeln **wichtige** Gedanken für das Team und halten sie für alle fest.`,
).join("\n");
// More lines than the preview holds: the editor's gutter has four digits, the preview's rows only three.
const manyMarkdown = Array.from({ length: 1200 }, (_, index) => `Zeile ${index + 1}`).join("\n");
// A chart right below the preview's lines: the preview reserves the box of the editor's chart widget.
const chartMarkdown = [
  "# Umsatz",
  "",
  "Wir vergleichen **Umsatz** und Kosten der ersten Monate.",
  "",
  ":::chart",
  "type: area",
  "title: Umsatz 2026 nach Monaten, mit einem Titel, der auf einem Telefon umbricht",
  "subtitle: In Euro",
  "columns: [Datum, Umsatz, Kosten]",
  "rows:",
  "  - [2026-01-01, 1200, 800]",
  "  - [2026-02-01, 1500, 900]",
  "  - [2026-03-01, 1400, 1000]",
  "x: Datum",
  "y: [Umsatz, Kosten]",
  ":::",
  "",
  "Danach geht es weiter.",
].join("\n");
// A note of paragraphs far longer than the editor draws at once, for printing.
const printMarkdown = `# Feldnotizen\n\n${Array.from({ length: 150 }, (_, index) => `Absatz ${index + 1}: Das Team notiert Beobachtungen für den nächsten Besuch.`).join("\n\n")}`;
const notes = {
  markdown: { text: markdown, snapshot: snapshot(markdown) },
  chart: { text: chartMarkdown, snapshot: snapshot(chartMarkdown) },
  print: { text: printMarkdown, snapshot: snapshot(printMarkdown) },
  headings: { text: headingMarkdown, snapshot: snapshot(headingMarkdown) },
  long: { text: longMarkdown, snapshot: snapshot(longMarkdown) },
  many: { text: manyMarkdown, snapshot: snapshot(manyMarkdown) },
};
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "note-preview.browser-harness.ts")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-note-preview-test",
        setup(builder) {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the real note editor.");
  const bundle = await build.outputs[0]!.text();
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")].map(
      async (entry) => {
        const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
        return build.outputs[0]!.text();
      },
    ),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/editor.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/notebooks/ws" && server.upgrade(request, { data: undefined })) return;
      if (url.pathname.endsWith("/block-preview")) {
        // Book's rendering of the posted draft, as the API returns it; the saved note in read-only mode.
        const body: unknown = await request.json();
        const draft =
          typeof body === "object" && body && "markdown" in body && typeof body.markdown === "string" ? body.markdown : markdown;
        const { blocks } = renderNotebookBook({ markdown: draft, notebookId: "book01", noteId: "note01", locale: "en", linkMode: "write" });
        return Response.json({ markdown: draft, blocks, diagnostics: [], headings: [] });
      }
      const { text: note, snapshot: initialSnapshot } =
        notes[(["many", "long", "headings", "chart", "print"] as const).find((name) => url.searchParams.has(name)) ?? "markdown"];
      const mode = url.searchParams.get("mode") === "source" ? "source" : "rich";
      const readOnly = url.searchParams.has("readonly");
      const historyIncomplete = url.searchParams.has("historyIncomplete");
      // The personal "Full width": the server renders the attribute from the cookie the editor reads at mount.
      const fullWidth = url.searchParams.has("fullWidth");
      const props = {
        noteId: "note01",
        noteTitle: "Wochenplan",
        notebookId: "book01",
        notebookName: "Team",
        noteLockedAt: null,
        historyIncomplete,
        workspaceCursor: null,
        appUrl: url.origin,
        userId: "writer",
        displayName: "Writer",
        initialSnapshot,
        initialRestoreRevision: "0",
        initialContent: null,
        initialPanelOpen: false,
        initialRichMode: mode,
        readOnly,
        initialHref: "/app/notebooks/book01/notes/note01",
        initialDetail: {
          noteAuthors: { createdBy: null, lastEditedBy: null },
          noteId: "note01",
          noteTitle: "Wochenplan",
          contentMd: note,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          lockedAt: null,
          historyIncomplete,
          isLocked: false,
          tocItems: [],
          taskProgress: { done: 0, total: 0 },
          attachments: [],
          backlinks: [],
          namedBlocks: [],
        },
      } satisfies ComponentProps<typeof NoteEditor>;
      const preview = renderToString(() => createComponent(NotePreview, { text: note, mode, historyIncomplete }));
      const serialized = Bun.escapeHTML(JSON.stringify(toJSON(props)));
      return new Response(
        `<!doctype html><html lang="en"${url.searchParams.has("dark") ? ' class="dark"' : ""}><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
        <style>solid-client,solid-island{display:contents}#layout{display:flex;height:100dvh}#navigation{width:288px;flex:none}#main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}@media(max-width:600px){#navigation{display:none}}</style>
        </head><body class="k2b-ui" style="margin:0"><div id="layout"><nav id="navigation">Notizbuch</nav><main id="main">
        <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col"${fullWidth ? " data-full-width" : ""}><solid-client data-id="note-editor" data-props="${serialized}"></solid-client>${preview}</div>
        </main></div><script type="module" src="/editor.js"></script></body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(fullWidth
              ? { "set-cookie": `settings-app-notebooks=${encodeURIComponent(JSON.stringify({ fullWidth: true }))}; Path=/` }
              : {}),
          },
        },
      );
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: notebooksYjs.wsType.replayReady, payload: { noteId: "note01" } }));
      },
      message() {},
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

// WebKit resolves `document.fonts.ready` only once the document has loaded, which
// the held editor script prevents; the font set's status does not wait for it.
const settle = (page: Page) =>
  page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    while (document.fonts.status !== "loaded") await frame();
    for (let index = 0; index < 5; index++) await frame();
  });
const measure = (page: Page, selector: string, count: number) =>
  page.evaluate(
    ({ selector, count }) =>
      Array.from(document.querySelectorAll(selector))
        .slice(0, count)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let glyph: { top: number; left: number; width: number; height: number } | null = null;
          for (let node = walker.nextNode(); node && !glyph; node = walker.nextNode()) {
            const offset = node.textContent?.search(/\S/) ?? -1;
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const box = range.getBoundingClientRect();
            glyph = { top: box.top, left: box.left, width: box.width, height: box.height };
          }
          return {
            box: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            glyph,
            color: getComputedStyle(element).color,
          };
        }),
    { selector, count },
  );
const closeTo = (actual: number, expected: number, context: string) => expect(Math.abs(actual - expected), context).toBeLessThanOrEqual(1);

for (const fixture of [
  { mode: "rich", width: 1280, height: 800, readOnly: false, dark: false, historyIncomplete: false, headings: false },
  { mode: "rich", width: 390, height: 844, readOnly: false, dark: false, historyIncomplete: false, headings: false },
  { mode: "source", width: 1280, height: 800, readOnly: false, dark: false, historyIncomplete: false, headings: false },
  { mode: "rich", width: 1280, height: 800, readOnly: true, dark: false, historyIncomplete: false, headings: false },
  { mode: "rich", width: 1280, height: 800, readOnly: false, dark: true, historyIncomplete: true, headings: false },
  { mode: "rich", width: 1280, height: 800, readOnly: false, dark: false, historyIncomplete: false, headings: true },
  { mode: "rich", width: 1280, height: 800, readOnly: false, dark: false, historyIncomplete: false, headings: false, fullWidth: true },
  { mode: "source", width: 1280, height: 800, readOnly: false, dark: false, historyIncomplete: false, headings: false, fullWidth: true },
] as const) {
  test(`preview hands off without moving lines or glyphs: ${fixture.mode}, ${fixture.width}px, ${fixture.readOnly ? "read-only" : "write"}, ${fixture.dark ? "dark" : "light"}${fixture.headings ? ", heading code" : ""}${"fullWidth" in fixture ? ", full width" : ""}`, async () => {
    const page = await browser.newPage({
      viewport: { width: fixture.width, height: fixture.height },
      isMobile: fixture.width === 390,
      hasTouch: fixture.width === 390,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/editor.js", async (route) => {
      await blocked;
      await route.continue();
    });
    try {
      await page.goto(
        `${server.url}?mode=${fixture.mode}${fixture.readOnly ? "&readonly" : ""}${fixture.dark ? "&dark" : ""}${fixture.historyIncomplete ? "&historyIncomplete" : ""}${fixture.headings ? "&headings" : ""}${"fullWidth" in fixture ? "&fullWidth" : ""}`,
        { waitUntil: "commit" },
      );
      const preview = page.locator(`#${NOTE_PREVIEW_ID}`);
      await preview.waitFor({ state: "visible" });
      const rows = preview.locator(".notebook-note-preview__line");
      expect(await rows.nth(0).isVisible()).toBe(true);
      expect(await rows.nth(2).isVisible()).toBe(true);
      expect(await rows.nth(0).textContent()).toBe("# Wochenplan");
      expect(await rows.nth(2).textContent()).toContain("Wir sammeln");
      expect(await preview.locator("script, img").count()).toBe(0);
      const count = notePreviewLines(fixture.headings ? headingMarkdown : markdown, fixture.mode).length;
      expect(await rows.count()).toBe(count);
      if (fixture.mode === "rich") expect(await preview.textContent()).not.toContain("a list item");
      await settle(page);
      const before = await measure(page, ".notebook-note-preview__line", count);
      // The paragraph fills the note beside the 288px navigation instead of the 44rem (704px) column.
      if ("fullWidth" in fixture) expect(before[2]!.box.width).toBeGreaterThan(900);
      release?.();
      await page.waitForSelector(".cm-content");
      await preview.waitFor({ state: "detached" });
      await settle(page);
      const after = await measure(page, ".cm-line", count);
      expect(errors).toEqual([]);
      expect(after).toHaveLength(before.length);
      before.forEach((line, index) => {
        const mounted = after[index]!;
        for (const property of ["top", "left", "width", "height"] as const) {
          closeTo(mounted.box[property], line.box[property], `Line ${index + 1}: ${property}`);
          if (line.glyph) {
            expect(mounted.glyph).not.toBeNull();
            closeTo(mounted.glyph![property], line.glyph[property], `Glyph ${index + 1}: ${property}`);
          } else expect(mounted.glyph).toBeNull();
        }
        expect(mounted.color).toBe(line.color);
      });
      expect(await page.locator(".cm-content").textContent()).toContain("a list item");
      expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe(fixture.readOnly ? "false" : "true");
      if (!fixture.readOnly) {
        await page.locator(".cm-content").focus();
        await page.keyboard.type("Hello");
        expect(await page.locator(".cm-content").textContent()).toContain("Hello");
      }
    } finally {
      release?.();
      await page.close();
    }
  }, 30_000);
}

test("a note longer than the preview keeps the editor's gutter and lines: source, 1280px", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/editor.js", async (route) => {
    await blocked;
    await route.continue();
  });
  try {
    await page.goto(`${server.url}?many&mode=source`, { waitUntil: "commit" });
    const preview = page.locator(`#${NOTE_PREVIEW_ID}`);
    await preview.waitFor({ state: "visible" });
    expect(await preview.locator(".notebook-note-preview__line").count()).toBe(NOTE_PREVIEW_BUDGET.lines);
    await settle(page);
    const before = await measure(page, ".notebook-note-preview__line", 20);
    release?.();
    await page.waitForSelector(".cm-content");
    await preview.waitFor({ state: "detached" });
    await settle(page);
    const after = await measure(page, ".cm-line", 20);
    expect(errors).toEqual([]);
    expect(after).toHaveLength(before.length);
    before.forEach((line, index) => {
      for (const property of ["top", "left", "width", "height"] as const) {
        closeTo(after[index]!.box[property], line.box[property], `Line ${index + 1}: ${property}`);
        closeTo(after[index]!.glyph![property], line.glyph![property], `Glyph ${index + 1}: ${property}`);
      }
    });
  } finally {
    release?.();
    await page.close();
  }
}, 30_000);

/** The first line row at the scroll port's top edge, with its text and where it starts relative to that edge. */
const topLine = (page: Page, line: string) =>
  page.evaluate((line) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(line));
    const port = rows[0]?.closest(".k2b-scroll-area");
    if (!port) throw new Error(`No scroll port around ${line}`);
    const edge = port.getBoundingClientRect().top;
    const row = rows.find((row) => row.getBoundingClientRect().bottom > edge);
    if (!row) throw new Error(`No ${line} at the top edge`);
    return { text: row.textContent, offset: row.getBoundingClientRect().top - edge, scrolled: port.scrollTop };
  }, line);

for (const fixture of [
  { mode: "rich", width: 1280, height: 800, readOnly: false },
  { mode: "rich", width: 390, height: 844, readOnly: false },
  { mode: "rich", width: 390, height: 844, readOnly: true },
  { mode: "source", width: 1280, height: 800, readOnly: false },
] as const) {
  test(`the editor opens where the reader scrolled the preview: ${fixture.mode}, ${fixture.width}px, ${fixture.readOnly ? "read-only" : "write"}`, async () => {
    const page = await browser.newPage({
      viewport: { width: fixture.width, height: fixture.height },
      isMobile: fixture.width === 390,
      hasTouch: fixture.width === 390,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/editor.js", async (route) => {
      await blocked;
      await route.continue();
    });
    try {
      await page.goto(`${server.url}?long&mode=${fixture.mode}${fixture.readOnly ? "&readonly" : ""}`, { waitUntil: "commit" });
      const preview = page.locator(`#${NOTE_PREVIEW_ID}`);
      await preview.waitFor({ state: "visible" });
      await settle(page);
      // Halfway into a wrapped line, so the restore has to keep an offset and not only a line.
      await preview.locator(".k2b-scroll-area").evaluate((port) => {
        port.scrollTop = 1210;
      });
      await settle(page);
      const before = await topLine(page, ".notebook-note-preview__line");
      expect(before.scrolled).toBeGreaterThan(1000);
      expect(before.text).not.toStartWith("Zeile 1:");
      // The line at the top edge in every frame, so not even one frame shows the note's start.
      const frames: string[] = [];
      await page.exposeFunction("recordTopLine", (text: string) => frames.push(text));
      await page.evaluate(() => {
        const record: unknown = Reflect.get(window, "recordTopLine");
        const frame = () => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>(".notebook-note-preview__line, .cm-line"));
          const edge = rows[0]?.closest(".k2b-scroll-area")?.getBoundingClientRect().top ?? 0;
          if (typeof record === "function") record(rows.find((row) => row.getBoundingClientRect().bottom > edge)?.textContent ?? "");
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      release?.();
      await page.waitForSelector(".cm-content");
      await preview.waitFor({ state: "detached" });
      await settle(page);
      const after = await topLine(page, ".cm-line");
      expect(errors).toEqual([]);
      expect(frames.length).toBeGreaterThan(0);
      expect(new Set(frames)).toEqual(new Set([before.text]));
      expect(after.text).toBe(before.text);
      closeTo(after.offset, before.offset, "Offset of the line at the top edge");
      if (!fixture.readOnly) {
        expect(await page.evaluate(() => document.activeElement?.classList.contains("cm-content"))).toBe(true);
      }
    } finally {
      release?.();
      await page.close();
    }
  }, 30_000);
}

for (const width of [375, 1280]) {
  test(`a chart keeps the box the preview reserved, while it loads and once it is drawn: ${width}px`, async () => {
    expect(notePreviewChart(chartMarkdown, notePreviewLines(chartMarkdown, "rich"))).toMatchObject({ kind: "line", area: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseEditor: (() => void) | undefined;
    let releasePreview: (() => void) | undefined;
    const editorHeld = new Promise<void>((resolve) => {
      releaseEditor = resolve;
    });
    const previewHeld = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    await page.route("**/editor.js", async (route) => {
      await editorHeld;
      await route.continue();
    });
    await page.route("**/block-preview", async (route) => {
      await previewHeld;
      await route.continue();
    });
    const box = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      });
    const same = (actual: Awaited<ReturnType<typeof box>>, expected: Awaited<ReturnType<typeof box>>, context: string) => {
      for (const property of ["top", "left", "width", "height"] as const)
        closeTo(actual[property], expected[property], `${context}: ${property}`);
    };
    try {
      await page.goto(`${server.url}?chart&mode=rich`, { waitUntil: "commit" });
      const preview = page.locator(`#${NOTE_PREVIEW_ID}`);
      await preview.waitFor({ state: "visible" });
      await settle(page);
      const reserved = await box(`#${NOTE_PREVIEW_ID} .cm-query-block-widget`);
      const reservedFrame = await box(`#${NOTE_PREVIEW_ID} .notebook-book-chart`);
      // Title, subtitle and an 18rem frame: never a one-line placeholder.
      expect(reservedFrame.height).toBeGreaterThan(320);
      releaseEditor?.();
      await page.waitForSelector(".cm-content .cm-query-block-widget .notebook-book-chart");
      await preview.waitFor({ state: "detached" });
      await settle(page);
      same(await box(".cm-content .cm-query-block-widget"), reserved, "Loading widget");
      same(await box(".cm-content .notebook-book-chart"), reservedFrame, "Loading frame");
      releasePreview?.();
      await page.waitForSelector(".cm-content .notebook-book-chart svg");
      await settle(page);
      same(await box(".cm-content .cm-query-block-widget"), reserved, "Drawn widget");
      same(await box(".cm-content .notebook-book-chart"), reservedFrame, "Drawn frame");
      expect(await page.locator(".cm-content .k2b-chart-legend li").allTextContents()).toEqual(["Umsatz", "Kosten"]);
      expect(errors).toEqual([]);
    } finally {
      releaseEditor?.();
      releasePreview?.();
      await page.close();
    }
  }, 30_000);
}

// The editor draws only what is near the viewport, so the page prints the note's Book copy instead (#1281).
for (const readOnly of [false, true])
  test(`prints the whole note from its Book copy, with text typed just before: ${readOnly ? "read-only" : "write"}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${server.url}?print${readOnly ? "&readonly" : ""}`);
      await page.waitForSelector(".cm-content");
      const copy = page.locator(".notebook-note-print");
      await copy.waitFor({ state: "attached" });
      expect(await copy.boundingBox()).toBeNull();
      if (!readOnly) {
        await page.locator(".cm-content").focus();
        await page.keyboard.press("Control+End");
        await page.keyboard.type(" Zuletzt getippt.");
      }
      await page.emulateMedia({ media: "print" });
      await page.waitForSelector(".notebook-note-print[data-print-region]", { state: "attached" });
      for (const selector of ["#navigation", ".cm-editor"]) expect(await page.locator(selector).boundingBox(), selector).toBeNull();
      const paragraphs = copy.locator("p");
      expect(await paragraphs.count()).toBe(150);
      for (const paragraph of await paragraphs.all()) expect(await paragraph.boundingBox()).not.toBeNull();
      expect((await paragraphs.last().boundingBox())!.y).toBeGreaterThan(800);
      expect(await copy.locator("h1").textContent()).toBe("Feldnotizen");
      if (!readOnly) expect(await paragraphs.last().textContent()).toContain("Zuletzt getippt.");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
