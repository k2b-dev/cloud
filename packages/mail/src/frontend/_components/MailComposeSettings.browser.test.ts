import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { ComposeSettingsHarnessOptions } from "./MailComposeSettings.browser-harness";

// Whether the logo keeps its box while the image loads, and whether a state change moves the controls around it, is
// layout, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailComposeSettings.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-compose-settings-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Compose settings harness build failed");
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
// As a Cloud page loads them: the layer order first, then the app's utilities, then the shared styles, whose
// responsive variants win over the app's plain utilities.
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
// The icon font gives icon-only buttons their real width.
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    // An image request that never answers: the logo's box while its image is still loading.
    if (url.pathname === "/pending-image") return new Promise<Response>(() => undefined);
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

type Rect = { x: number; y: number; width: number; height: number };

const load = async (
  context: BrowserContextOptions,
  options: Omit<ComposeSettingsHarnessOptions, "logo"> & { logo: "demo" | null | "fail"; theme?: "light" | "dark" },
) => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate(async ({ theme: _theme, ...harnessOptions }) => {
    const logo = harnessOptions.logo === "demo" ? await window.demoLogo(600, 200, 200) : harnessOptions.logo;
    window.mountComposeSettings({ ...harnessOptions, logo });
  }, options);
  await page.locator("[data-mail-logo-stage]").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  return Object.assign(page, { errors });
};

const rect = async (page: Page, selector: string): Promise<Rect> => {
  const value = await page.locator(selector).first().boundingBox();
  if (!value) throw new Error(`${selector} is not visible`);
  return value;
};

/** Every box around the logo that a state change must leave in place. */
const controls = async (page: Page) => ({
  stage: await rect(page, "[data-mail-logo-stage]"),
  dropzone: await rect(page, ".k2b-dropzone"),
  width: await page
    .getByLabel(/^(Display width|Anzeigebreite)/)
    .first()
    .boundingBox(),
  alt: await page
    .getByLabel(/^(Alt text|Alternativtext)/)
    .first()
    .boundingBox(),
  actions: await page.locator("[data-mail-logo-stage]").evaluate((stage) => {
    const group = stage.closest(".k2b-settings-group");
    const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>("button:not(.k2b-dropzone)") ?? []);
    return buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  }),
});

/** Picks a file in the device's dialog, which the dropzone opens when no Cloud app offers files. */
const chooseDeviceFile = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => {
  // Provider discovery runs when the page is idle; wait for its answer so the click opens the device's dialog.
  await page.waitForFunction(() => window.providerCatalogAnswered);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".k2b-dropzone").click()]);
  await chooser.setFiles(file);
};

const logoImage = "[data-mail-logo-stage] img";
const loadedLogo = async (page: Page) => {
  await page.locator(logoImage).waitFor();
  await page.locator(logoImage).evaluate((image: HTMLImageElement) => image.decode());
  return rect(page, logoImage);
};

/** The box the same logo takes while its image has not arrived yet. */
const pendingLogo = (page: Page) =>
  page.locator(logoImage).evaluate((image: HTMLImageElement) => {
    const pending = image.cloneNode() as HTMLImageElement;
    pending.src = "/pending-image";
    image.replaceWith(pending);
    const box = pending.getBoundingClientRect();
    return { complete: pending.complete, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });

describe("Mailbox logo settings", () => {
  for (const [device, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`keeps the logo box and the controls still from loading to a loaded image on ${device}`, async () => {
      const page = await load(context, { locale: "en", permission: "admin", logo: "demo" });
      try {
        await page.getByText("Loading logo").waitFor();
        const loading = await controls(page);

        await page.evaluate(() => window.answerLogoLoad());
        const loaded = await loadedLogo(page);
        // 600x200 pixels shown 200 px wide: the stored size gives the box.
        expect(loaded.width).toBe(200);
        expect(loaded.height).toBeCloseTo(200 / 3, 1);
        expect(await controls(page)).toEqual(loading);

        const pending = await pendingLogo(page);
        expect(pending.complete).toBe(false);
        expect(pending.box).toEqual(loaded);
        expect(await controls(page)).toEqual(loading);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`keeps the controls in place from no logo to an uploaded logo on ${device}`, async () => {
      const page = await load(context, { locale: "de", permission: "admin", logo: null });
      try {
        await page.evaluate(() => window.answerLogoLoad());
        await page.getByText("Noch kein Logo").waitFor();
        const empty = await controls(page);
        const file = await page.evaluate(async () => {
          const logo = await window.demoLogo(300, 100, 200);
          return logo.dataUrl.slice(logo.dataUrl.indexOf(",") + 1);
        });
        await chooseDeviceFile(page, { name: "logo.png", mimeType: "image/png", buffer: Buffer.from(file, "base64") });
        await loadedLogo(page);
        expect(
          await page.evaluate(() => window.logoRequests.filter((request) => request.method === "PUT").map((request) => request.body)),
        ).toEqual([{ content: file }]);
        const uploaded = await controls(page);
        expect(uploaded.stage).toEqual(empty.stage);
        expect(uploaded.dropzone).toEqual(empty.dropzone);
        expect(uploaded.width).toEqual(empty.width);
        expect(uploaded.alt).toEqual(empty.alt);
        expect(uploaded.actions).toEqual(empty.actions);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-dropzone"))).toBe(true);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("shows the logo on the recipient's white paper in dark mode", async () => {
    const page = await load(desktop, { locale: "en", permission: "write", logo: "demo", theme: "dark" });
    try {
      await page.evaluate(() => window.answerLogoLoad());
      await loadedLogo(page);
      // Paper fades its background, so wait for the end of the fade instead of reading it halfway.
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector("[data-mail-logo-stage]")!).backgroundColor === "rgb(255, 255, 255)",
      );
      expect(await page.locator(".k2b-dropzone").isDisabled()).toBe(true);
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
