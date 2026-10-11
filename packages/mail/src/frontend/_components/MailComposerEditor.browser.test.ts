import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { ComposeFormattingWarning } from "../../contracts";
import type { MailComposerEditorHarnessOptions } from "./MailComposerEditor.browser-harness";

// Whether the hint about removed HTML leaves the previewed message in place and stays on screen on a phone is a
// layout question, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailComposerEditor.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-composer-editor-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Composer editor harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
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
const phone: BrowserContextOptions = { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const load = async (options: { context: BrowserContextOptions; theme: "light" | "dark"; locale: "en" | "de" }) => {
  const page = await (await browser.newContext(options.context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailComposerEditorHarnessOptions) => window.mountComposerEditor(harnessOptions), {
    locale: options.locale,
  } satisfies MailComposerEditorHarnessOptions);
  return Object.assign(page, { errors });
};

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} is not visible`);
  return rect;
};
/** Where the first paragraph of the previewed message sits on the page. */
const messageStart = async (page: Page) => {
  const rect = await page.frameLocator('iframe[sandbox=""]').locator("p").first().boundingBox();
  if (!rect) throw new Error("The previewed message is not visible");
  return rect;
};

const warnings: ComposeFormattingWarning[] = [
  { code: "unsupported_element", element: "small" },
  { code: "unsupported_attribute", element: "span", attribute: "class" },
];
const manyWarnings: ComposeFormattingWarning[] = Array.from({ length: 20 }, (_, index) => ({
  code: "unsupported_element",
  element: `x-tag${index}`,
}));

describe("Mail composer preview", () => {
  for (const [label, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`lists removed HTML below the message without moving it on ${label} in ${theme} mode`, async () => {
        const locale = theme === "dark" ? "de" : "en";
        const page = await load({ context, theme, locale });
        try {
          await page.waitForSelector('iframe[sandbox=""]');
          const frame = await box(page, 'iframe[sandbox=""]');
          const start = await messageStart(page);

          await page.evaluate((list) => window.setFormattingWarnings(list), warnings);
          const title =
            locale === "de"
              ? "Ein Teil des HTML dieser Nachricht wird in der E-Mail weggelassen."
              : "Email leaves out some of the HTML in this message.";
          const hint = page.locator(".k2b-inline-guidance", { hasText: title });
          await hint.waitFor();

          // The message keeps its place; the hint takes room below it and stays on screen.
          expect(await messageStart(page)).toEqual(start);
          const shown = await box(page, 'iframe[sandbox=""]');
          expect({ x: shown.x, y: shown.y, width: shown.width }).toEqual({ x: frame.x, y: frame.y, width: frame.width });
          const hintBox = await box(page, ".k2b-inline-guidance");
          expect(hintBox.y).toBeGreaterThanOrEqual(shown.y + shown.height - 0.5);
          expect(hintBox.y + hintBox.height).toBeLessThanOrEqual((context.viewport?.height ?? 0) + 0.5);
          expect(hintBox.x + hintBox.width).toBeLessThanOrEqual((context.viewport?.width ?? 0) + 0.5);
          expect(await hint.locator("li").count()).toBe(2);

          // A long list scrolls inside a bounded hint instead of pushing the message away.
          await page.evaluate((list) => window.setFormattingWarnings(list), manyWarnings);
          await page.waitForFunction(() => document.querySelectorAll(".k2b-inline-guidance li").length === 20);
          const bounded = await box(page, ".k2b-inline-guidance");
          expect(bounded.height).toBeLessThanOrEqual(112.5);
          expect(await page.locator(".k2b-inline-guidance").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
          expect((await box(page, 'iframe[sandbox=""]')).y).toBe(frame.y);
          expect(await messageStart(page)).toEqual(start);

          await page.evaluate(() => window.setFormattingWarnings([]));
          await hint.waitFor({ state: "detached" });
          expect(await box(page, 'iframe[sandbox=""]')).toEqual(frame);
          expect(page.errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});
