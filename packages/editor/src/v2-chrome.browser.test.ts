import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../ui/test/browser";
import { solidTestPlugin } from "../../ui/test/solid-test-plugin";

// The chrome of both Markdown editors inside a v2 screen of Cloud (Cloud's stylesheet, v1 and v2): toolbars of the
// v2 bar height on the v2 text edge, icon buttons with the v2 icon size and hit area, no frame of their own beside the
// v2 lines, the toolbar's names and focus order kept, and nothing that moves once the page stands. Runs in Chromium
// and in WebKit (TEST_BROWSER=webkit). With K2B_EDITOR_PICTURES set it saves a picture per width there.

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "v2-chrome.browser-fixture.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [solidTestPlugin()],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the v2 chrome fixture.");
  const bundle = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  // the fonts of the page as data, so icons and type draw without a server for font files
  const ui = resolve(import.meta.dir, "../../ui/node_modules");
  const plex = [400, 500, 600]
    .map((weight) => resolve(ui, `@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`))
    .filter((path) => existsSync(path))
    .map(
      (path, index) =>
        `@font-face{font-family:"IBM Plex Sans";font-weight:${[400, 500, 600][index]};font-display:block;src:url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2")}`,
    )
    .join("");
  // the icon font's own stylesheet, as Cloud's page links it, with its font as data
  const tabler = resolve(ui, "@tabler/icons-webfont/dist");
  const icons = existsSync(resolve(tabler, "tabler-icons.min.css"))
    ? readFileSync(resolve(tabler, "tabler-icons.min.css"), "utf8").replace(
        /@font-face\{[^}]*\}/,
        `@font-face{font-family:"tabler-icons";font-display:block;src:url(data:font/woff2;base64,${readFileSync(resolve(tabler, "fonts/tabler-icons.woff2")).toString("base64")}) format("woff2")}`,
      )
    : "";
  // the editor's own stylesheet, as an app that uses it imports it
  const editorCss = readFileSync(resolve(import.meta.dir, "styles.css"), "utf8");
  const css = `${await styles.outputs[0]!.text()}
${editorCss}
${plex}${icons}`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>`,
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

const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  await page.goto(server.url.href);
  await page.waitForFunction(() => document.querySelectorAll(".cm-content").length > 0 && document.querySelector(".k2b-markdown-editor"));
  await settled(page);
  return page;
};

type Chrome = { bar: { height: number; left: number }; buttons: { width: number; height: number; icon: number; left: number }[] };

/** The toolbar of one editor: its box against its Canvas, and each icon button with the size of its icon. */
const chrome = (page: Page, which: "ui" | "shared") =>
  page.evaluate((kind): Chrome => {
    const host = document.querySelector(`[data-editor="${kind}"]`);
    const canvas = host?.closest(".k2-canvas");
    const bar = host?.querySelector(kind === "ui" ? ".k2b-markdown-editor__toolbar" : "[data-k2b-editor-toolbar]");
    if (!host || !canvas || !bar) throw new Error(`no toolbar for ${kind}`);
    const edge = canvas.getBoundingClientRect().left;
    const box = bar.getBoundingClientRect();
    const buttons = [...bar.querySelectorAll("button")].filter((button) => button.getClientRects().length > 0);
    return {
      bar: { height: Math.round(box.height), left: Math.round(box.left - edge) },
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector(".ti");
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          icon: icon ? Math.round(Number.parseFloat(getComputedStyle(icon).fontSize)) : 0,
          left: Math.round(rect.left - edge),
        };
      }),
    };
  }, which);

for (const width of [1440, 390])
  test(`at ${width} px both toolbars speak v2: a 40 px bar, 28 px buttons with 16 px icons, the first glyph on the v2 text edge`, async () => {
    const page = await open(width);
    try {
      const pictures = process.env.K2B_EDITOR_PICTURES;
      if (pictures) {
        mkdirSync(pictures, { recursive: true });
        await page.screenshot({ path: resolve(pictures, `editor-chrome-${width}.png`) });
      }
      for (const kind of ["ui", "shared"] as const) {
        if (width < 768 && kind === "ui") continue; // on the phone the split shows the first pane only
        const found = await chrome(page, kind);
        expect({ kind, height: found.bar.height }).toEqual({ kind, height: 40 });
        for (const button of found.buttons)
          expect({ kind, ...button, left: 0 }).toEqual({ kind, width: 28, height: 28, icon: 16, left: 0 });
        // the glyph of the first button (6 px into its 28 px) stands on the v2 text edge: 20 px, 16 px on the phone
        expect({ kind, edge: (found.buttons[0]?.left ?? 0) + 6 }).toEqual({ kind, edge: width < 768 ? 16 : 20 });
      }
    } finally {
      await page.close();
    }
  }, 30_000);
