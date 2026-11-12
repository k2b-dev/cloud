import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
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
  browser = await launchBrowser();
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
  await page.locator(".k2b-file-grid__open").nth(index).click();
  await page.locator("dialog.k2b-lightbox[open] .k2b-content-markdown").waitFor();
  return page;
};

describe("Mail attachment preview in the Lightbox", () => {
  test("a document shows a placeholder while it loads, then its title in the name pill", async () => {
    delay = 400;
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.goto(server.url.href);
      await page.evaluate((list) => window.mountAttachments(list), attachments);
      await page.locator(".k2b-file-grid__open").first().click();
      await page.locator('dialog.k2b-lightbox[open] .k2b-lightbox__placeholder[role="status"]').waitFor();
      await page.locator("dialog.k2b-lightbox[open] .k2b-content-markdown").waitFor();
      expect(await page.locator("dialog.k2b-lightbox[open]").getAttribute("aria-label")).toBe("Summer party 2026");
    } finally {
      delay = 0;
      await page.context().close();
    }
  }, 30_000);

  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`a long name stays on one line and nothing scrolls sideways on ${name}`, async () => {
      const page = await openPreview(context, 1);
      try {
        // The document's title leads; the long file name follows in the facts and never pushes into the actions.
        const layout = await page.evaluate(() => {
          const pill = document.querySelector<HTMLElement>("dialog.k2b-lightbox .k2b-lightbox__name")!.getBoundingClientRect();
          const actions = document.querySelector<HTMLElement>("dialog.k2b-lightbox .k2b-lightbox__actions")!.getBoundingClientRect();
          return {
            pillHeight: pill.height,
            clear: pill.right <= actions.left,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        expect(await page.locator("dialog.k2b-lightbox[open]").getAttribute("aria-label")).toBe("Planning");
        expect(layout).toEqual({ pillHeight: 40, clear: true, overflow: false });
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("focus starts on the file, so Page Down scrolls a long document at once", async () => {
    const page = await openPreview(desktop, 0);
    try {
      expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-lightbox__stage"))).toBeTrue();
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => document.querySelector("dialog.k2b-lightbox .k2b-lightbox__stage")!.scrollTop > 0);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
