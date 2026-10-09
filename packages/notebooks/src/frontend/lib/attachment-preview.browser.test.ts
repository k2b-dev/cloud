import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { Attachment } from "../[id]/_components/editor/attachments-client";

// The frame, the reading column, the phone layout and the title size need real layout, so the real attachments
// overview runs in a browser with the shipped stylesheets.
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
/** Milliseconds the content endpoint waits before it answers. */
let delay = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const file = files[/^\/api\/notebooks\/nb0001\/attachments\/(\w+)\/content$/u.exec(url.pathname)?.[1] ?? ""];
    if (file) {
      if (delay) await Bun.sleep(delay);
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

const open = async (context: BrowserContextOptions, index: number, ready: string): Promise<Page> => {
  const page = await (await browser.newContext(context)).newPage();
  // Chromium's headless shell reports no inline PDF viewer, where the preview shows a hint instead of the frame;
  // these tests measure the frame a desktop or phone browser with a viewer shows.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { get: () => true }));
  await page.goto(server.url.href);
  await page.evaluate((list) => window.mountAttachments(list, "en"), attachments);
  await page.locator(".notebooks-attachment-tile__open").nth(index).click();
  await page.locator(`.k2b-dialog[open] ${ready}`).waitFor();
  return page;
};

const layout = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(".k2b-dialog[open]")!;
    const box = (selector: string) => dialog.querySelector(selector)!.getBoundingClientRect();
    const frame = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    return {
      frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
      border: style.borderTopWidth,
      title: Number.parseFloat(getComputedStyle(dialog.querySelector(".k2b-panel-dialog__heading h2")!).fontSize),
      body: box(".k2b-panel-dialog__body"),
      overflow: document.documentElement.scrollWidth > window.innerWidth || dialog.scrollWidth > dialog.clientWidth,
    };
  });

describe("Notebook attachment preview layout", () => {
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

  test("a document reads in a column whose title holds still while the file loads", async () => {
    delay = 400;
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.goto(server.url.href);
      await page.evaluate((list) => window.mountAttachments(list, "en"), attachments);
      await page.locator(".notebooks-attachment-tile__open").first().click();
      await page.locator(".k2b-dialog[open] .notebooks-attachment-dialog__title-pending").waitFor();
      const loading = await page.evaluate(() => ({
        titleTop: document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__heading h2")!.getBoundingClientRect().top,
        bodyTop: document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__body")!.getBoundingClientRect().top,
      }));
      await page.locator(".k2b-dialog[open] .k2b-content-markdown").waitFor();
      const loaded = await layout(page);
      expect(loaded.frame.width).toBe(640);
      expect(loaded.title).toBe(24);
      expect(loaded.body.top).toBe(loading.bodyTop);
      expect(await page.evaluate(() => document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__heading h2")!.textContent)).toBe(
        "Summer party 2026",
      );
      expect(
        await page.evaluate(() => document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__heading h2")!.getBoundingClientRect().top),
      ).toBe(loading.titleTop);
      expect(loaded.overflow).toBeFalse();
    } finally {
      delay = 0;
      await page.context().close();
    }
  }, 30_000);

  test("on a phone the preview takes the whole screen without a border", async () => {
    const page = await open(phone, 0, ".k2b-content-markdown");
    try {
      const shown = await layout(page);
      expect(shown.frame).toEqual({ left: 0, top: 0, width: 390, height: 844 });
      expect(shown.border).toBe("0px");
      expect(shown.title).toBe(20);
      expect(shown.overflow).toBeFalse();
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`a PDF fills the frame's height on ${name}`, async () => {
      const page = await open(context, 1, ".k2b-content-pdf-preview__frame");
      try {
        const shown = await layout(page);
        const frame = await page.evaluate(() => {
          const body = document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__body")!;
          const box = document.querySelector(".k2b-dialog[open] .k2b-content-pdf-preview__frame")!.getBoundingClientRect();
          return { height: box.height, bottom: box.bottom, inset: Number.parseFloat(getComputedStyle(body).paddingBottom) };
        });
        // The document reaches the body's inset at the bottom, so nothing scrolls around it.
        expect(frame.bottom).toBeCloseTo(shown.body.bottom - frame.inset, 0);
        expect(frame.height).toBeGreaterThan(shown.frame.height / 2);
        expect(shown.overflow).toBeFalse();
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("focus starts on the content, so Page Down scrolls a long document at once", async () => {
    const page = await open(desktop, 0, ".k2b-content-markdown");
    try {
      expect(await page.evaluate(() => document.activeElement?.classList.contains("notebooks-attachment-dialog__content"))).toBeTrue();
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__body")!.scrollTop > 0);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
