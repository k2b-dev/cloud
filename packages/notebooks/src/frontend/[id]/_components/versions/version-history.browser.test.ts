import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";

const buildHarness = async (): Promise<string> => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "version-history.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-version-history-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Version history harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../styles/app.css")));
const uiDist = resolve(import.meta.dir, "../../../../../../ui/dist");
const fonts = (await Promise.all(["plex.css", "tabler.css"].map((file) => Bun.file(resolve(uiDist, file)).text())))
  .map((sheet) => sheet.replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui-fonts/"))
  .join("\n");
const fontFiles = new Map(
  Array.from(new Bun.Glob("**/*.woff2").scanSync({ cwd: uiDist })).map((file) => [`/ui-fonts/${file}`, Bun.file(resolve(uiDist, file))]),
);
const restorePath = "/api/notebooks/Book01/notes/Note01/versions/Version01/restore";
let restoreReceived = Promise.withResolvers<void>();
let pendingRestore: { request: Request; release: (response: Response) => void } | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === restorePath && request.method === "POST") {
      return new Promise<Response>((release) => {
        pendingRestore = { request, release };
        restoreReceived.resolve();
      });
    }
    if (/^\/api\/notebooks\/Book01\/notes\/Note01\/versions\/Version0[123]\/content$/.test(path))
      return Response.json({ contentMd: "# Saved content\n\nA previous version of the runbook.", yjsSnapshot: "" });
    if (path === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (fontFiles.has(path)) return new Response(fontFiles.get(path)!);
    if (path === "/styles.css") return new Response(`${css}\n${fonts}`, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0;height:100vh;display:flex;flex-direction:column">' +
        '<div id="root" style="display:flex;flex:1;min-height:0"></div><script src="/harness.js"></script></body></html>',
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

const viewports: { name: string; options: BrowserContextOptions }[] = [
  { name: "desktop", options: { viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
  { name: "phone", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" } },
];
const labels = {
  en: { primary: "Restore this version", copy: "Restore as copy", menu: "More restore options", locked: "Locked" },
  de: {
    primary: "Diese Version wiederherstellen",
    copy: "Als Kopie wiederherstellen",
    menu: "Weitere Optionen zum Wiederherstellen",
    locked: "Gesperrt",
  },
};
const open = async (options: BrowserContextOptions, locale: "en" | "de", locked = false) => {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto(new URL("/app/notebooks/Book01/notes/Note01?mode=versions", server.url).href);
  await page.evaluate(({ locale, locked }) => window.mountVersionHistory(locale, locked), { locale, locked });
  await page.locator("button[aria-pressed]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const select = async (page: Page) => {
  await page.locator("button[aria-pressed]").first().click();
  await page.locator("article").getByRole("heading", { name: "Saved content" }).waitFor();
};
const primary = (page: Page) => page.locator(".k2b-split-button__primary");
const menu = (page: Page) => page.locator(".k2b-split-button__menu-trigger");
const header = (page: Page) => page.locator("header");
const preview = (page: Page) => page.locator(".app-cols > div:last-child");
const settle = async (page: Page) => {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await header(page).evaluate(async (head) => {
    await Promise.all(
      head
        .getAnimations({ subtree: true })
        .filter((animation) => animation.timeline === document.timeline)
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
};
const boxes = async (page: Page) => {
  await settle(page);
  return {
    header: await header(page).boundingBox(),
    primary: await primary(page).boundingBox(),
    menu: await menu(page).boundingBox(),
    preview: await preview(page).boundingBox(),
  };
};
type Box = { x: number; y: number; width: number; height: number };
const sameBox = (before: Box | null, after: Box | null, name: string) => {
  expect(before, `${name} before`).not.toBeNull();
  expect(after, `${name} after`).not.toBeNull();
  for (const axis of ["x", "y", "width", "height"] as const) {
    const delta = after![axis] - before![axis];
    expect(Math.abs(delta), `${name}.${axis} moved ${delta}px (${before![axis]} -> ${after![axis]})`).toBeLessThanOrEqual(0.5);
  }
};
const shot = async (page: Page, name: string) => {
  if (process.env.VERSION_HISTORY_SHOTS !== "1") return;
  await mkdir("/tmp/restore-version-shots", { recursive: true });
  await page.screenshot({ path: `/tmp/restore-version-shots/${browserName}-${name}.png`, fullPage: true });
};

const measureFit = (page: Page) =>
  header(page).evaluate((head) => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    // A closed menu keeps its items in the document; only the controls on screen count.
    controls: Array.from(head.querySelectorAll<HTMLElement>("button, a"))
      .filter((control) => control.checkVisibility())
      .map((control) => {
        const rect = control.getBoundingClientRect();
        const label = control.querySelector<HTMLElement>(".k2b-button__label, span");
        let left = 0;
        let right = innerWidth;
        for (let parent = control.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX !== "visible") {
            const bounds = parent.getBoundingClientRect();
            left = Math.max(left, bounds.left + parent.clientLeft);
            right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
          }
        }
        return {
          label: control.getAttribute("aria-label") ?? control.textContent?.trim(),
          left: rect.left,
          right: rect.right,
          clipLeft: left,
          clipRight: right,
          labelWidth: label?.clientWidth ?? 0,
          labelScrollWidth: label?.scrollWidth ?? 0,
        };
      }),
  }));
const fits = (measurements: Awaited<ReturnType<typeof measureFit>>, state: string) => {
  expect(measurements.scrollWidth, `${state} document scrollWidth`).toBeLessThanOrEqual(measurements.width);
  expect(measurements.controls.length).toBeGreaterThan(0);
  for (const control of measurements.controls) {
    expect(control.left, `${state} ${control.label} left edge`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${state} ${control.label} right edge`).toBeLessThanOrEqual(measurements.width);
    expect(control.left, `${state} ${control.label} clipped on left`).toBeGreaterThanOrEqual(control.clipLeft);
    expect(control.right, `${state} ${control.label} clipped on right`).toBeLessThanOrEqual(control.clipRight);
    expect(control.labelScrollWidth, `${state} ${control.label} truncated label`).toBeLessThanOrEqual(control.labelWidth);
  }
};

for (const viewport of viewports) {
  for (const locale of ["en", "de"] as const) {
    describe(`version history ${viewport.name} ${locale}`, () => {
      test("header, restore controls and preview stay in place through selection, pending restore and error", async () => {
        const page = await open(viewport.options, locale);
        try {
          expect(await primary(page).isDisabled()).toBe(true);
          expect(await menu(page).isDisabled()).toBe(true);
          const before = await boxes(page);
          const beforeFit = await measureFit(page);
          await select(page);
          const selected = await boxes(page);
          const selectedFit = await measureFit(page);
          if (viewport.name === "phone" || locale === "en") await shot(page, `${viewport.name}-${locale}-selected`);
          restoreReceived = Promise.withResolvers<void>();
          await primary(page).click();
          await restoreReceived.promise;
          await page.waitForFunction(() => document.querySelector(".k2b-split-button__primary")?.getAttribute("aria-busy") === "true");
          expect(await primary(page).isDisabled()).toBe(true);
          expect(await menu(page).isDisabled()).toBe(true);
          const pending = await boxes(page);
          const pendingFit = await measureFit(page);
          expect(pendingRestore).toBeDefined();
          expect(new URL(pendingRestore!.request.url).pathname).toBe(restorePath);
          pendingRestore!.release(Response.json({ message: "Cannot restore locked note" }, { status: 403 }));
          pendingRestore = undefined;
          await page.locator("[data-k2b-toast]:not([data-closing])").getByText("Cannot restore locked note", { exact: true }).waitFor();
          await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-split-button__primary")?.disabled);
          const failed = await boxes(page);
          const failedFit = await measureFit(page);
          for (const [state, measured] of [
            ["selected", selected],
            ["pending", pending],
            ["error", failed],
          ] as const) {
            for (const key of ["header", "primary", "menu"] as const) sameBox(before[key], measured[key], `${state} ${key}`);
            expect(before.preview, "preview before").not.toBeNull();
            expect(measured.preview, `${state} preview`).not.toBeNull();
            const delta = measured.preview!.y - before.preview!.y;
            expect(Math.abs(delta), `${state} preview top moved ${delta}px`).toBeLessThanOrEqual(0.5);
          }
          for (const [state, measured] of [
            ["initial", beforeFit],
            ["selected", selectedFit],
            ["pending", pendingFit],
            ["error", failedFit],
          ] as const)
            fits(measured, state);
        } finally {
          pendingRestore?.release(Response.json({ message: "Cancelled" }, { status: 403 }));
          pendingRestore = undefined;
          await page.context().close();
        }
      }, 30_000);

      test("actions fit the viewport with complete labels before and after selection", async () => {
        const page = await open(viewport.options, locale);
        try {
          fits(await measureFit(page), "initial");
          await select(page);
          fits(await measureFit(page), "selected");
        } finally {
          await page.context().close();
        }
      }, 30_000);

      test("restore has its translated name, stays put on hover and opens the copy menu", async () => {
        const page = await open(viewport.options, locale);
        try {
          await select(page);
          expect(await page.getByRole("button", { name: labels[locale].primary, exact: true }).count()).toBe(1);
          const before = await primary(page).boundingBox();
          await primary(page).hover();
          await settle(page);
          sameBox(before, await primary(page).boundingBox(), "hover primary");
          expect(await page.getByRole("button", { name: labels[locale].menu, exact: true }).count()).toBe(1);
          await menu(page).click();
          await page
            .getByRole("menu")
            .getByRole("menuitem")
            .filter({ has: page.getByText(labels[locale].copy, { exact: true }) })
            .waitFor();
          if (viewport.name === "phone") await shot(page, `phone-${locale}-menu`);
        } finally {
          await page.context().close();
        }
      }, 30_000);

      test("locked notes have only the secondary copy action with a complete translated label", async () => {
        const page = await open(viewport.options, locale, true);
        try {
          expect(await primary(page).count()).toBe(0);
          expect(await menu(page).count()).toBe(0);
          expect(await page.getByRole("button", { name: labels[locale].primary, exact: true }).count()).toBe(0);
          await header(page).getByText(labels[locale].locked, { exact: true }).waitFor();
          const copy = page.getByRole("button", { name: labels[locale].copy, exact: true });
          expect(await copy.getAttribute("data-variant")).toBe("secondary");
          expect(await copy.isDisabled()).toBe(true);
          await select(page);
          expect(await copy.isEnabled()).toBe(true);
          fits(await measureFit(page), "locked selected");
        } finally {
          await page.context().close();
        }
      }, 30_000);
    });
  }
}
