import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../ui/test/browser";
import { solidTestPlugin } from "../../ui/test/solid-test-plugin";

// The menu lies in the top layer as a popover and follows the selection's geometry: only a real engine shows it.
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

declare global {
  interface Window {
    bubble: {
      select: (from: number, to: number) => void;
      edit: (from: number, insert: string) => void;
      selected: () => string;
      open: () => boolean;
    };
  }
}

beforeAll(async () => {
  const entry = resolve(import.meta.dir, "BubbleMenu.browser-fixture.ts");
  const fixture = `
import { EditorSelection } from "@codemirror/state";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, render } from "solid-js/web";
import { BubbleMenu, Editor, createEditor, markdownActions } from "./index";

let editor;
render(() => {
  editor = createEditor();
  const actions = markdownActions(editor, "en");
  return createComponent(LocaleProvider, {
    locale: "en",
    get children() {
      return [
        createComponent(Editor, { editor, label: "Note", initialValue: "Harbor crane schedule", maxLength: 10000, toolbar: false }),
        createComponent(BubbleMenu, { editor, groups: [[actions.bold]] }),
      ];
    },
  });
}, document.getElementById("root"));
window.bubble = {
  select: (from, to) => {
    editor.view().focus();
    editor.view().dispatch({ selection: EditorSelection.single(from, to) });
  },
  // A collaborator's edit arrives as a change without a selection of its own.
  edit: (from, insert) => editor.view().dispatch({ changes: { from, insert } }),
  selected: () => {
    const { from, to } = editor.view().state.selection.main;
    return editor.view().state.sliceDoc(from, to);
  },
  open: () => document.querySelector("[popover]:popover-open") !== null,
};
`;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [solidTestPlugin()],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the bubble menu fixture.");
  const bundle = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../styles.css")], plugins: [tailwind] });
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
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>` +
          `<body class="k2b-ui" style="margin:0;padding:80px"><div id="root" style="width:640px"></div><script src="/fixture.js"></script></body></html>`,
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

const isOpen = async (page: Page) => {
  await settled(page);
  return page.evaluate(() => window.bubble.open());
};

test("Escape keeps the menu closed while a collaborator types, and a new selection opens it again", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await page.goto(server.url.href);
    await page.waitForFunction(() => document.querySelector(".cm-content"));
    await page.evaluate(() => window.bubble.select(7, 12));
    expect(await isOpen(page)).toBe(true);

    await page.keyboard.press("Escape");
    expect(await isOpen(page)).toBe(false);

    // Someone else edits after and before the selection; the dismissed selection only moves along with the text.
    await page.evaluate(() => window.bubble.edit(21, " today"));
    await page.evaluate(() => window.bubble.edit(0, "New "));
    expect(await page.evaluate(() => window.bubble.selected())).toBe("crane");
    expect(await isOpen(page)).toBe(false);

    await page.evaluate(() => window.bubble.select(4, 10));
    expect(await isOpen(page)).toBe(true);
  } finally {
    await page.close();
  }
});
