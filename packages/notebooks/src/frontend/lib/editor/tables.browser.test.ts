import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";

// The table widget's bleed reaches into the editor content's inline padding,
// which only a real engine lays out and clips.
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const entry = resolve(import.meta.dir, "tables.browser-fixture.ts");
  const fixture = `
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, lineNumbers } from "@codemirror/view";
import { markdownExtension } from "./markdown";
import { tablesExtension } from "./tables";
import { customLightInit, rawLightInit } from "./theme";

const doc = [
  "Für die nächsten Wochen planen wir drei feste Formate.",
  "Jedes Format hat eine feste Zeit.",
  "Die Dauer steht rechts.",
  "",
  "| Format | Wann | Dauer |",
  "| --- | --- | --: |",
  "| Firmen-Reel | Mi, 18:00 | 30 min |",
  "| Rückblick | Sa, 11:00 | 45 min |",
  "",
  "Danach folgt die Abstimmung.",
].join("\\n");
// The note editor's scroller inset (NoteEditor.client.tsx).
const scroller = EditorView.theme({ ".cm-editor": { minHeight: "100%" }, ".cm-scroller": { width: "100%", minHeight: "100%", padding: "1rem" } });
const editor = (id, extensions) =>
  new EditorView({
    parent: document.getElementById(id),
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdownExtension(), drawSelection(), EditorView.lineWrapping, scroller, ...extensions] }),
  });
window.rich = editor("rich", [tablesExtension("ABC123"), customLightInit()]);
editor("raw", [rawLightInit(), lineNumbers()]);
`;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the table widget fixture.");
  const bundle = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="rich" style="width:640px"></div><div id="raw" style="width:640px"></div><script src="/fixture.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("the editor table widget bleeds like the Book: flush text, one width for lines and bands, nothing clipped", async () => {
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  try {
    await page.goto(server.url.href);
    await page.waitForSelector("#rich .cm-table-widget .md-table");
    const measure = () =>
      page.evaluate(() => {
        // `+ 0` turns WebKit's sub-pixel `-0` into `0`.
        const round = (value: number) => Math.round(value * 10) / 10 + 0;
        const wrap = document.querySelector("#rich .cm-table-widget .md-table-wrap")!;
        const box = wrap.getBoundingClientRect();
        const scroller = document.querySelector<HTMLElement>("#rich .cm-scroller")!;
        const left = scroller.getBoundingClientRect().left + scroller.clientLeft;
        const line = document.createRange();
        line.selectNodeContents(document.querySelector("#rich .cm-line")!);
        const prose = line.getBoundingClientRect();
        const text = (cell: Element) => {
          const span = cell.querySelector(":scope > .md-table-cell")!;
          const style = getComputedStyle(span);
          const rect = span.getBoundingClientRect();
          return { left: rect.left + Number.parseFloat(style.paddingLeft), right: rect.right - Number.parseFloat(style.paddingRight) };
        };
        const rows = Array.from(wrap.querySelectorAll("tr"));
        const cells = rows.flatMap((row) => Array.from(row.children));
        return {
          rows: rows.map((row) => {
            const rect = row.getBoundingClientRect();
            return [round(rect.left - box.left), round(box.right - rect.right)];
          }),
          bands: cells.map((cell) => {
            const rect = cell.getBoundingClientRect();
            const inner = text(cell);
            return [round(inner.left - rect.left), round(rect.right - inner.right)];
          }),
          // The scroller clips sideways at its padding edge; the bleed reaches into its padding and stays inside.
          inside: box.left >= left - 0.5 && box.right <= left + scroller.clientWidth + 0.5,
          sideways: scroller.scrollWidth - scroller.clientWidth,
          flush: round(text(cells[0]!).left - prose.left),
          layout: cells.map((cell) => {
            const rect = cell.getBoundingClientRect();
            // Page coordinates: hovering may scroll the page into view.
            return [rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height];
          }),
        };
      });
    const idle = await measure();
    expect({ ...idle, layout: undefined }).toEqual({
      rows: idle.rows.map(() => [0, 0]),
      bands: idle.bands.map(() => [8, 8]),
      inside: true,
      sideways: 0,
      flush: 0,
      layout: undefined,
    });
    await page.locator("#rich .cm-table-widget tbody tr").last().locator("td").nth(1).hover();
    expect((await measure()).layout).toEqual(idle.layout);
  } finally {
    await page.close();
  }
});

test("the table's room past the text leaves selections and the raw-mode gutter where the text is", async () => {
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  try {
    await page.goto(server.url.href);
    await page.waitForSelector("#rich .cm-table-widget .md-table");
    await page.evaluate(() => {
      const view = (window as unknown as { rich: import("@codemirror/view").EditorView }).rich;
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.line(3).to } });
    });
    await page.waitForSelector("#rich .cm-selectionBackground");
    const geometry = await page.evaluate(() => {
      const round = (value: number) => Math.round(value * 10) / 10 + 0;
      const line = document.createRange();
      line.selectNodeContents(document.querySelector("#rich .cm-line")!);
      const start = line.getBoundingClientRect().left;
      const end = document.querySelector("#rich .cm-content")!.getBoundingClientRect().right;
      const scroller = document.querySelector("#raw .cm-scroller")!.getBoundingClientRect();
      const gutters = document.querySelector("#raw .cm-gutters")!.getBoundingClientRect();
      const content = document.querySelector("#raw .cm-content")!.getBoundingClientRect();
      return {
        // Each selected line's highlight starts at the text; a whole line's ends at the text column's edge.
        selection: Array.from(document.querySelectorAll("#rich .cm-selectionBackground"), (rect) => {
          const box = rect.getBoundingClientRect();
          return [round(box.left - start), round(end - box.right)];
        }),
        // The gutter sits on the scroller's inset and keeps its gap to the text.
        gutter: [round(gutters.left - scroller.left), round(content.left - gutters.right)],
      };
    });
    // The selection ends inside the third line, so only the highlights above it reach the column's edge.
    const ends = geometry.selection.map(([, end]) => end);
    expect(geometry.selection.length).toBeGreaterThan(1);
    expect({ ...geometry, selection: geometry.selection.map(([start]) => start), ends: ends.slice(0, -1) }).toEqual({
      selection: geometry.selection.map(() => 0),
      ends: ends.slice(0, -1).map(() => 0),
      gutter: [16, 12],
    });
    expect(ends.at(-1)).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});
