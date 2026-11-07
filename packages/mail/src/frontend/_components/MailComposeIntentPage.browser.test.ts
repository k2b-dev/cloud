import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

// Whether the person sees only the preparing state, never a chooser, before the composer opens, and where Back leads
// from there, is layout and browser history, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailComposeIntentPage.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-compose-intent-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Compose intent harness build failed");
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
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
// As in Cloud's Layout, the island sits in a block-level app area that it fills.
const page = (body: string) =>
  new Response(
    '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0}</style></head>' +
      `<body class="k2b-ui" style="margin:0">${body}</body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    if (url.pathname === "/app/mail/compose") return page('<div id="root"></div><script src="/harness.js"></script>');
    return page(`<h1>${url.pathname}</h1>`);
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

describe("Mail compose link with one mailbox and one sender", () => {
  for (const width of [390, 1440]) {
    test(`opens the composer without a chooser and Back returns to the origin at ${width} px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: width < 600 ? 844 : 900 },
        ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(10_000);
      const errors = pageErrors(tab);
      try {
        await tab.goto(new URL("/origin", server.url).href);
        await tab.goto(new URL("/app/mail/compose", server.url).href);
        await tab.waitForFunction(() => window.seedRequests.length === 1);

        const preparing = tab.getByText("Preparing message...");
        await preparing.waitFor();
        const box = await preparing.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        // The chooser stays out of sight from the first frame on: no field, no Continue.
        expect(await tab.getByRole("combobox").count()).toBe(0);
        expect(await tab.getByRole("button", { name: "Continue" }).isVisible()).toBe(false);
        expect(await tab.locator("section").isVisible()).toBe(false);

        await tab.evaluate(() => window.answerSeed());
        await tab.waitForURL(/\/app\/mail\/mail01\/compose\/local\/20000000-0000-4000-8000-000000000002\?return=%2Forigin$/);

        await tab.goBack();
        expect(new URL(tab.url()).pathname).toBe("/origin");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  }
});
