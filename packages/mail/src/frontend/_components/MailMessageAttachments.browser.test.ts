import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";
import type { MailAttachmentsHarnessAttachment } from "./MailMessageAttachments.browser-harness";

// Type sizes, line clamping, truncation and focus need real layout, so the real attachment list runs in a browser.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailMessageAttachments.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-attachments-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail attachments harness build failed");
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
const files: Record<string, { filename: string; body: string }> = {
  Att001: {
    filename: "Summer_party.md",
    body: `# Summer party 2026\n\nEverything the organising team needs.\n\n## Schedule\n\n${schedule}\n`,
  },
  Att002: {
    filename: "Quarterly planning notes for the summer party organising committee 2026 final version.md",
    body: "# Planning\n\nBody text here.\n",
  },
};
const attachments: MailAttachmentsHarnessAttachment[] = Object.entries(files).map(([id, file]) => ({
  id,
  filename: file.filename,
  contentType: "text/plain",
  sizeBytes: file.body.length,
}));

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** Milliseconds the attachment endpoint waits before it answers. */
let delay = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const file = files[/^\/api\/mail\/mailboxes\/Box001\/messages\/Msg001\/attachments\/(\w+)$/u.exec(pathname)?.[1] ?? ""];
    if (file) {
      if (delay) await Bun.sleep(delay);
      return new Response(file.body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="root" style="padding:16px"></div>' +
        '<script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const openPreview = async (context: BrowserContextOptions, index: number): Promise<Page> => {
  const page = await (await browser.newContext(context)).newPage();
  await page.goto(server.url.href);
  await page.evaluate((list) => window.mountAttachments(list), attachments);
  await page.locator(".mail-attachment-preview").nth(index).click();
  await page.locator(".k2b-dialog[open] .k2b-content-markdown").waitFor();
  return page;
};

const heading = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector(".k2b-dialog[open]")!;
    const box = (selector: string) => dialog.querySelector(selector)!.getBoundingClientRect();
    const name = dialog.querySelector<HTMLElement>(".mail-attachment-dialog__facts-name");
    return {
      title: Number.parseFloat(getComputedStyle(dialog.querySelector(".k2b-panel-dialog__heading h2")!).fontSize),
      section: Number.parseFloat(getComputedStyle(dialog.querySelector(".k2b-content-markdown h2") ?? document.body).fontSize),
      titleTop: box(".k2b-panel-dialog__heading h2").top,
      bodyTop: box(".k2b-panel-dialog__body").top,
      factsHeight: box(".mail-attachment-dialog__facts").height,
      nameTruncated: name ? name.scrollWidth > name.clientWidth : null,
      nameTitle: name?.title ?? null,
    };
  });

describe("Mail attachment preview layout", () => {
  test("the document title stands above its section headings and holds still while the attachment loads", async () => {
    delay = 400;
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.goto(server.url.href);
      await page.evaluate((list) => window.mountAttachments(list), attachments);
      await page.locator(".mail-attachment-preview").first().click();
      await page.locator(".k2b-dialog[open] .mail-attachment-dialog__title-pending").waitFor();
      const loading = await page.evaluate(() => ({
        titleTop: document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__heading h2")!.getBoundingClientRect().top,
        bodyTop: document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__body")!.getBoundingClientRect().top,
      }));
      await page.locator(".k2b-dialog[open] .k2b-content-markdown").waitFor();
      const loaded = await heading(page);
      expect(loaded.title).toBe(24);
      expect(loaded.section).toBeLessThan(loaded.title);
      expect(loaded.titleTop).toBe(loading.titleTop);
      expect(loaded.bodyTop).toBe(loading.bodyTop);
    } finally {
      delay = 0;
      await page.context().close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`a long file name stays on one quiet line on ${name}`, async () => {
      const page = await openPreview(context, 1);
      try {
        const layout = await heading(page);
        expect(layout.nameTruncated).toBeTrue();
        expect(layout.nameTitle).toBe(files.Att002!.filename);
        expect(layout.factsHeight).toBeLessThanOrEqual(20);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("focus starts on the content, so Page Down scrolls a long document at once", async () => {
    const page = await openPreview(desktop, 0);
    try {
      expect(await page.evaluate(() => document.activeElement?.classList.contains("mail-attachment-dialog__content"))).toBeTrue();
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => document.querySelector(".k2b-dialog[open] .k2b-panel-dialog__body")!.scrollTop > 0);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
