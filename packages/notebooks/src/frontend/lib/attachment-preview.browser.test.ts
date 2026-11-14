import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { Attachment } from "../[id]/_components/editor/attachments-client";

// Focus rings, stepping and the phone layout need a real browser, so the real attachments overview runs there with
// the shipped stylesheets. The Lightbox's own layout is covered in @k2b/ui.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./attachment-preview.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-notebook-attachments-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Notebook attachments harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

/** Invented demo attachments. */
const schedule = Array.from({ length: 60 }, (_, index) => `- ${String(10 + (index % 10))}:00 Stand ${index + 1}`).join("\n");
const pdf =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
// A 1x1 PNG, which an image tile scales up to fill its square.
const png = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");
const files: Record<string, { filename: string; mimeType: string; body: string | Uint8Array<ArrayBuffer> }> = {
  Att001: {
    filename: "Summer_party.md",
    mimeType: "text/markdown",
    body: `# Summer party 2026\n\nEverything the organising team needs.\n\n## Schedule\n\n${schedule}\n`,
  },
  Att002: { filename: "Floor_plan.pdf", mimeType: "application/pdf", body: pdf },
  Att003: { filename: "Stands.csv", mimeType: "text/csv", body: "Stand,Team\nGrill,Team A\nDrinks,Team B\n" },
  Att004: { filename: "Stage.png", mimeType: "image/png", body: png },
};
const attachments: Attachment[] = Object.entries(files).map(([id, file]) => ({
  id,
  kind: file.mimeType.startsWith("image/") ? "image" : "file",
  filename: file.filename,
  mimeType: file.mimeType,
  sizeBytes: file.body.length,
  notebookId: "nb0001",
  createdBy: null,
  createdAt: "2026-09-01T08:00:00.000Z",
}));

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** Attachment ids whose content the page has read, with the query it asked for. */
const reads: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const id = /^\/api\/notebooks\/nb0001\/attachments\/(\w+)\/content$/u.exec(url.pathname)?.[1] ?? "";
    const file = files[id];
    if (file) {
      reads.push(`${id}${url.search}`);
      const inline = url.searchParams.get("inline") === "true";
      return new Response(file.body, { headers: { "Content-Type": inline ? file.mimeType : "application/octet-stream" } });
    }
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="root" style="padding:16px"></div>' +
        '<script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const mount = async (context: BrowserContextOptions): Promise<Page> => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(server.url.href);
  await page.evaluate((list) => window.mountAttachments(list, "en"), attachments);
  return page;
};
/** The name the Lightbox shows, which is also its accessible name. */
const shownName = (page: Page) => page.locator("dialog.k2b-lightbox[open]").getAttribute("aria-label");

describe("Notebook attachment preview", () => {
  test("a focused image tile shows its focus ring above the thumbnail", async () => {
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.goto(server.url.href);
      await page.evaluate((list) => window.mountAttachments(list, "en"), [attachments[3]!]);
      const tile = page.locator(".notebooks-attachment-tile__open");
      await tile.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      // The left edge in the middle of the tile, away from the action buttons that appear in its top-right corner.
      const box = (await tile.boundingBox())!;
      const edge = { x: box.x, y: box.y + box.height / 2, width: 2, height: 8 };
      const unfocused = await page.screenshot({ clip: edge });
      await page.keyboard.press("Tab");
      expect(await tile.evaluate((element) => element.matches(":focus-visible"))).toBeTrue();
      expect((await page.screenshot({ clip: edge })).equals(unfocused)).toBeFalse();
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: a tile opens the Lightbox with every attachment, and the arrow keys step through them`, async () => {
      reads.length = 0;
      const page = await mount(context);
      try {
        await page.locator(".notebooks-attachment-tile__open").first().click();
        const lightbox = page.locator("dialog.k2b-lightbox[open]");
        // Markdown lifts its first heading into the name pill; the file name moves into the facts.
        await lightbox.locator(".k2b-content-markdown").waitFor();
        expect(await shownName(page)).toBe("Summer party 2026");
        expect(await lightbox.locator(".k2b-lightbox__name").textContent()).toContain("Summer_party.md");
        // The dialog's former buttons sit in the action pill: Save to Files, Download and Close.
        const download = lightbox.locator('a[aria-label="Download"]');
        expect(await download.getAttribute("href")).toBe("/api/notebooks/nb0001/attachments/Att001/content?v=1");
        expect(await lightbox.locator(".k2b-lightbox__action").count()).toBe(1);
        // The film strip names all four attachments of the list.
        expect(await lightbox.locator(".k2b-thumbnail-strip__thumb").count()).toBe(4);

        // The PDF loads from the inline address the content endpoint serves it at.
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector("dialog.k2b-lightbox")?.getAttribute("aria-label") === "Floor_plan.pdf");
        await lightbox.locator(".k2b-pdf-viewer, .k2b-lightbox__notice").first().waitFor();
        expect(reads).toContain("Att002?v=1&inline=true");

        // The table and the picture follow.
        await page.keyboard.press("ArrowRight");
        await lightbox.locator(".k2b-content-file-view").waitFor();
        expect(await shownName(page)).toBe("Stands.csv");
        await page.keyboard.press("ArrowRight");
        await lightbox.locator('img[alt="Stage.png"]').waitFor();

        // The Lightbox covers the screen and nothing scrolls sideways.
        const geometry = await page.evaluate(() => {
          const box = document.querySelector("dialog.k2b-lightbox")!.getBoundingClientRect();
          return { width: box.width, height: box.height, overflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(geometry).toEqual({ width: context.viewport!.width, height: context.viewport!.height, overflow: false });

        await page.keyboard.press("Escape");
        await lightbox.waitFor({ state: "detached" });
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});
