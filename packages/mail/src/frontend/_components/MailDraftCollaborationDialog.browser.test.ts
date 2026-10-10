import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";

// Whether two choice labels fit beside each other in the small dialog, or have to stack, depends on real text
// metrics, which only a real engine has.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailDraftCollaborationDialog.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-draft-collaboration-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Draft collaboration harness build failed");
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
const stylesheets: Record<string, string> = {
  "/app.css": await buildCss(resolve(import.meta.dir, "../../styles/app.css")),
  "/global.css": await buildCss(resolve(import.meta.dir, "../../../../../styles.css")),
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    const stylesheet = stylesheets[url.pathname];
    if (stylesheet) return new Response(stylesheet, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    // The stylesheets in the order and layers of Cloud's pages: the app's own before the global one.
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        "<style>@layer properties, theme, base, components, utilities;</style>" +
        '<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/global.css"></head>' +
        '<body class="k2b-ui" style="margin:0"><script src="/harness.js"></script></body></html>',
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

const viewports: Record<string, BrowserContextOptions> = {
  desktop: { viewport: { width: 1180, height: 820 } },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const labels = {
  en: { readonly: "View read-only", takeover: "Edit in this tab" },
  de: { readonly: "Schreibgeschützt öffnen", takeover: "In diesem Tab bearbeiten" },
};

describe("Draft open in another tab", () => {
  for (const [size, context] of Object.entries(viewports)) {
    for (const locale of ["en", "de"] as const) {
      test(`shows both choices whole on a ${size} in ${locale === "en" ? "English" : "German"}`, async () => {
        const page = await (await browser.newContext(context)).newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(server.url.href);
          await page.evaluate((value) => window.openDraftCollaboration(value), locale);
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          const readonly = dialog.getByRole("button", { name: labels[locale].readonly, exact: true });
          const takeover = dialog.getByRole("button", { name: labels[locale].takeover, exact: true });
          const layout = await page.evaluate(() => {
            const rect = (element: Element) => element.getBoundingClientRect().toJSON() as DOMRect;
            const frame = document.querySelector("dialog")!;
            const actions = frame.querySelector(".mail-draft-collaboration-actions")!;
            const buttons = Array.from(actions.querySelectorAll<HTMLElement>("button"));
            return {
              frame: rect(frame),
              actions: rect(actions),
              buttons: buttons.map((button) => ({
                box: rect(button),
                // A label wider than its button would be cut off.
                clipped: Array.from(button.querySelectorAll<HTMLElement>(".k2b-button__label")).some(
                  (label) =>
                    label.scrollWidth > label.clientWidth || label.getBoundingClientRect().right > button.getBoundingClientRect().right,
                ),
              })),
              frameScrolls: frame.scrollWidth > frame.clientWidth,
              viewport: window.innerWidth,
            };
          });
          expect(layout.frameScrolls).toBe(false);
          expect(layout.frame.right).toBeLessThanOrEqual(layout.viewport);
          expect(layout.buttons).toHaveLength(2);
          for (const button of layout.buttons) {
            expect(button.clipped).toBe(false);
            expect(button.box.left).toBeGreaterThanOrEqual(layout.actions.left - 0.5);
            expect(button.box.right).toBeLessThanOrEqual(layout.actions.right + 0.5);
            expect(button.box.right).toBeLessThanOrEqual(layout.frame.right);
          }
          const [first, second] = layout.buttons.map((button) => button.box);
          // Side by side with the main choice last, or stacked with the main choice on top; never overlapping.
          if (Math.abs(first!.top - second!.top) < 1) expect(second!.left).toBeGreaterThanOrEqual(first!.right);
          else expect(second!.bottom).toBeLessThanOrEqual(first!.top);
          expect(await readonly.isVisible()).toBe(true);
          expect(await takeover.isVisible()).toBe(true);

          await takeover.click();
          await dialog.waitFor({ state: "hidden" });
          expect(await page.evaluate(() => window.collaborationChoices)).toEqual(["takeover"]);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});
