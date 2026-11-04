import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";

// Whether switching between the pending body states moves anything needs real layout and real text wrapping.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailMessageCard.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-message-card-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail message card harness build failed");
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
/** How the server answers the reader's next body request, and every request body it received. */
let answer: { state: string; waitedMs: number } = { state: "requested", waitedMs: 0 };
const bodyRequests: unknown[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (request.method === "POST" && pathname === "/api/mail/mailboxes/Box001/messages/Msg001/body-request") {
      bodyRequests.push(await request.json());
      return Response.json(answer);
    }
    if (pathname.startsWith("/api/")) return Response.json({ items: [] });
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="root"></div>' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const smallPhone: BrowserContextOptions = { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true };

const layout = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-mail-message-id="Msg001"]')!.getBoundingClientRect();
    const state = document.querySelector("[data-mail-body-state]")!.getBoundingClientRect();
    return { cardBottom: card.bottom, stateTop: state.top, stateHeight: state.height };
  });

describe("Mail reader pending body", () => {
  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", phone],
    ["small phone", smallPhone],
  ] as const) {
    for (const locale of ["en", "de"] as const) {
      test(`loading, waiting for the mailbox and a failed body take the same place on ${name} in ${locale}`, async () => {
        answer = { state: "requested", waitedMs: 0 };
        bodyRequests.length = 0;
        const page = await (await browser.newContext(context)).newPage();
        try {
          await page.goto(server.url.href);
          await page.evaluate((value) => window.mountReader(value), locale);
          const pendingState = page.locator('[data-mail-body-state] .k2b-placeholder[data-state="loading"]');
          await pendingState.waitFor();
          while (bodyRequests.length < 1) await Bun.sleep(10);
          const loading = await layout(page);

          // The server has counted more than the deadline since the first request, as after a reload.
          answer = { state: "requested", waitedMs: 31_000 };
          await pendingState.locator("button").click();
          await page.locator("[data-mail-body-waiting]").waitFor();
          const waiting = await layout(page);

          await page.evaluate(() => window.setHydration("failed"));
          const failedState = page.locator('[data-mail-body-state] .k2b-placeholder[data-state="error"]');
          await failedState.waitFor();
          const failed = await layout(page);

          answer = { state: "unavailable", waitedMs: 0 };
          await failedState.locator("button").click();
          await failedState.locator("button").waitFor({ state: "detached" });
          const unavailable = await layout(page);

          expect(bodyRequests).toEqual([{}, { retry: true }, { retry: true }]);
          for (const state of [waiting, failed, unavailable]) expect(state).toEqual(loading);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});
