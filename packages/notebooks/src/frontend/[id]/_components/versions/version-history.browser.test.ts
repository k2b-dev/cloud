import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { hoverInPlace, launchBrowser } from "../../../../../../ui/test/browser";

const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "version-history.browser-harness.tsx")],
    target: "browser",
    format: "esm",
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

const restorePath = "/api/notebooks/Book01/notes/Note01/versions/Version01/restore";
let restoreReceived = Promise.withResolvers<void>();
let pendingRestore: { request: Request; release: (response: Response) => void } | undefined;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  const harness = await buildHarness();
  // the shipped page-head order and cascade: Cloud, the app, then v2
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await buildCss(resolve(import.meta.dir, "../../../../styles/app.css")),
    await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
  ].join("\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === restorePath && request.method === "POST")
        return new Promise<Response>((release) => {
          pendingRestore = { request, release };
          restoreReceived.resolve();
        });
      if (/^\/api\/notebooks\/Book01\/notes\/Note01\/versions\/Version0[123]\/content$/.test(path))
        return Response.json({ contentMd: "# Saved content\n\nA previous version of the runbook.", yjsSnapshot: "" });
      if (/^\/api\/accounts\/users\/[^/]+\/avatar$/.test(path))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#247b92"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(path)) return new Response(Bun.file(resolve(ui, "dist", path.slice(1))));
      if (path === "/harness.js") return new Response(harness, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const viewports: { name: string; options: BrowserContextOptions }[] = [
  { name: "desktop", options: { viewport: { width: 1440, height: 900 }, colorScheme: "light" } },
  { name: "phone", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" } },
];
const labels = {
  en: { primary: "Restore", copy: "Restore as copy", menu: "More restore options", locked: "Locked", back: "Saved versions" },
  de: {
    primary: "Wiederherstellen",
    copy: "Als Kopie wiederherstellen",
    menu: "Weitere Optionen zum Wiederherstellen",
    locked: "Gesperrt",
    back: "Gespeicherte Versionen",
  },
};
/** Pins only Date in the page (timers and frames stay real), from this instant on. */
const pinPageDate = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};
const listUrl = "/app/notebooks/Book01/notes/Note01?mode=versions";
const open = async (options: BrowserContextOptions, locale: "en" | "de", locked = false, version: string | null = null) => {
  const context = await browser.newContext(options);
  // relative times ("yesterday") read the clock, so the page's Date starts at a fixed instant
  await context.addInitScript(pinPageDate, Date.parse("2026-10-12T10:00:00.000Z"));
  const page = await context.newPage();
  await page.goto(new URL(version ? `${listUrl}&version=${version}` : listUrl, server.url).href);
  await page.waitForFunction(() => typeof window.mountVersionHistory === "function");
  await page.evaluate(({ locale, locked, version }) => window.mountVersionHistory(locale, locked, version), { locale, locked, version });
  await page.locator('[data-k2-part="Pane.Split"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const article = (page: Page) => page.locator("article").getByRole("heading", { name: "Saved content" });
const head = (page: Page) => page.locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Bar"]').first();
type Box = { x: number; y: number; width: number; height: number } | null;
const sameBox = (before: Box, after: Box, name: string) => {
  expect(before, `${name} before`).not.toBeNull();
  expect(after, `${name} after`).not.toBeNull();
  for (const axis of ["x", "y", "width", "height"] as const)
    expect(Math.abs(after![axis] - before![axis]), `${name}.${axis} ${before![axis]} -> ${after![axis]}`).toBeLessThanOrEqual(0.5);
};

for (const viewport of viewports) {
  for (const locale of ["en", "de"] as const) {
    describe(`version history ${viewport.name} ${locale}`, () => {
      test("the list and the open version are a clean v2 workspace, and the open version is in the address", async () => {
        const page = await open(viewport.options, locale);
        try {
          await page.locator('[data-k2-part="Row"] a').first().click();
          await article(page).waitFor();
          expect(new URL(page.url()).searchParams.get("version")).toBe("Version01");
          await settle(page);
          const outline = await describeV2Page(page, "#root");
          expect(outline.includes("Problems (") ? outline : "").toBe("");
          // the panes; the sidebar keeps the v1 note tree (k2b-ui gap: Nav tree)
          expect((await measureV2Layout(page, { root: '[data-k2-part="Pane.Split"]' })).problems).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          if (viewport.name === "phone") {
            // on the phone the open version is the page, and its way back returns to the list
            await page.getByRole("link", { name: labels[locale].back }).click();
            await page.locator("article").waitFor({ state: "detached" });
            expect(new URL(page.url()).searchParams.get("version")).toBeNull();
          } else {
            await page.goBack();
            await page.locator("article").waitFor({ state: "detached" });
          }
        } finally {
          await page.context().close();
        }
      }, 60_000);

      test("Restore stays in place while it runs and after it fails, and the failure says the server's reason", async () => {
        const page = await open(viewport.options, locale, false, "Version01");
        try {
          await article(page).waitFor();
          const restore = page.getByRole("button", { name: labels[locale].primary, exact: true });
          const before = { head: await head(page).boundingBox(), restore: await restore.boundingBox() };
          restoreReceived = Promise.withResolvers<void>();
          await restore.click();
          await restoreReceived.promise;
          await page.waitForFunction(() => document.querySelector('[data-k2-part="Button"][aria-busy="true"]') !== null);
          sameBox(before.restore, await restore.boundingBox(), "pending restore");
          expect(new URL(pendingRestore!.request.url).pathname).toBe(restorePath);
          pendingRestore!.release(Response.json({ message: "Cannot restore locked note" }, { status: 403 }));
          pendingRestore = undefined;
          await page.locator('[data-k2-part="Toast"]').getByText("Cannot restore locked note").waitFor();
          await page.waitForFunction(() => document.querySelector('[data-k2-part="Button"][aria-busy="true"]') === null);
          await settle(page);
          sameBox(before.head, await head(page).boundingBox(), "head after the failure");
          sameBox(before.restore, await restore.boundingBox(), "restore after the failure");
        } finally {
          pendingRestore?.release(Response.json({ message: "Cancelled" }, { status: 403 }));
          pendingRestore = undefined;
          await page.context().close();
        }
      }, 60_000);

      test("Restore has its translated name, stays put on hover and its menu restores as a copy", async () => {
        const page = await open(viewport.options, locale, false, "Version01");
        try {
          await article(page).waitFor();
          const restore = page.getByRole("button", { name: labels[locale].primary, exact: true });
          const before = await restore.boundingBox();
          await hoverInPlace(restore);
          await settle(page);
          sameBox(before, await restore.boundingBox(), "hover restore");
          await page.getByRole("button", { name: labels[locale].menu, exact: true }).click();
          await page.getByRole("menuitem").filter({ hasText: labels[locale].copy }).waitFor();
        } finally {
          await page.context().close();
        }
      }, 60_000);

      test("a locked note offers only Restore as copy, and says Locked under the head", async () => {
        const page = await open(viewport.options, locale, true, "Version01");
        try {
          await article(page).waitFor();
          expect(await page.getByRole("button", { name: labels[locale].primary, exact: true }).count()).toBe(0);
          expect(await page.getByRole("button", { name: labels[locale].menu, exact: true }).count()).toBe(0);
          // the state of the version stands under its head, beside the views
          await page
            .locator('[data-k2-part="Pane"][data-detail] [data-k2-part="Bar"]')
            .nth(1)
            .getByText(labels[locale].locked, { exact: true })
            .waitFor();
          const copy = page.getByRole("button", { name: labels[locale].copy, exact: true });
          expect(await copy.isEnabled()).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        } finally {
          await page.context().close();
        }
      }, 60_000);
    });
  }
}
