import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import type { PrintCopyHarness } from "./editor/note-print-copy.browser-harness";

declare const window: Window & { printCopyHarness: PrintCopyHarness };
const markdown =
  "# Field notebook\n\n" +
  Array.from({ length: 150 }, (_, i) => `Paragraph ${i + 1}. An invented team records observations for the next visit.`).join("\n\n") +
  `

| Place | Observation |
| --- | --- |
| Garden | Clear sky |

:::info
Bring a notebook.
:::

![A blue square](/square.svg)

:::query
source: notes
columns:
  - $title
:::
`;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "editor/note-print-copy.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-note-print-copy-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the note-print-copy harness.");
  const bundle = await build.outputs[0]!.text();
  // Use the shipped page-head order and cascade, including the responsive switch rule.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (new URL(request.url).pathname === "/square.svg")
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="blue"/></svg>', {
          headers: { "content-type": "image/svg+xml" },
        });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script id="markdown" type="text/plain">${markdown}</script><script src="/harness.js"></script></body></html>`,
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

test("the Book copy prints the whole note; changes at print time replace the stale copy", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(String(server.url));
    await page.waitForSelector(".notebook-note-print", { state: "attached" });
    expect(await page.locator(".notebook-note-print").boundingBox()).toBeNull();
    await page.emulateMedia({ media: "print" });
    await page.waitForSelector(".notebook-note-print[data-print-region]", { state: "attached" });
    for (const selector of [".k2b-app-workspace__sidebar", ".k2b-app-workspace__detail", ".editor-toolbar", ".editor-surface"])
      expect({ selector, box: await page.locator(selector).boundingBox() }).toEqual({ selector, box: null });
    const paragraphs = page.locator(".notebook-note-print p").filter({ hasText: /^Paragraph \d+\./ });
    expect(await paragraphs.count()).toBe(150);
    for (const paragraph of await paragraphs.all()) expect(await paragraph.boundingBox()).not.toBeNull();
    expect((await paragraphs.last().boundingBox())!.y).toBeGreaterThan(900);
    for (const selector of ["h1", "table", ".k2b-notice-card", "img", "code"])
      expect(await page.locator(`.notebook-note-print ${selector}`).first().boundingBox()).not.toBeNull();
    expect(await page.locator(".notebook-note-print img").getAttribute("loading")).toBe("eager");
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".notebook-note-print img")?.naturalWidth === 4);
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.printCopyHarness.change("# Updated note\n\nFresh content at print time."));
    await page.emulateMedia({ media: "print" });
    await page.waitForFunction(() => document.querySelector(".notebook-note-print")?.textContent?.includes("Fresh content at print time."));
    expect(await page.locator(".notebook-note-print").textContent()).not.toContain("Paragraph 150.");
    // beforeprint is an independent path (including browsers without print media events).
    await page.evaluate(() => {
      window.printCopyHarness.change("# Beforeprint\n\nLatest local text.");
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(await page.locator(".notebook-note-print").textContent()).toContain("Latest local text.");
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.printCopyHarness.switchNote("# Another note\n\nOnly this note."));
    expect(await page.locator(".notebook-note-print").getAttribute("data-print-region")).toBeNull();
    await page.emulateMedia({ media: "print" });
    await page.waitForSelector(".notebook-note-print[data-print-region]", { state: "attached" });
    expect(await page.locator(".notebook-note-print").textContent()).toContain("Only this note.");
    await page.evaluate(() => {
      window.printCopyHarness.dispose();
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(await page.locator(".notebook-note-print").getAttribute("data-print-region")).toBeNull();
  } finally {
    await page.close();
  }
}, 30_000);
