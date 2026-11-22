import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { type FixtureReviewVariant, fixtureApprovalDetail } from "../packages/core/src/pages/admin/code/CodeArea.fixture-data";
import { launchBrowser, pageErrors, settled } from "../packages/ui/test/browser";

const root = resolve(import.meta.dir, "..");
const shots = process.env.CAPBLOCKS_SHOTS;
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  setSystemTime(new Date("2026-11-17T08:49:00.000Z"));
  const ui = resolve(root, "packages/ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "approval-parity.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "approval-parity-dom",
        setup(builder) {
          // The cross-app harness has no application package scope; resolve the public browser distribution explicitly.
          builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "dist/browser/index.js") }));
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
  if (!build.success) throw new AggregateError(build.logs, "Approval parity harness failed");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(root, "packages/cloud")))).default;
  const styles: string[] = [];
  for (const path of ["styles.css", "packages/assistant/src/styles/app.css", "packages/core/src/styles/app.css"]) {
    const output = await Bun.build({ entrypoints: [resolve(root, path)], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}`);
    styles.push(await output.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const adminFixtures = Object.fromEntries(
    (["normal", "own", "sole", "approved", "rejected", "changes", "withdrawn", "followup"] satisfies FixtureReviewVariant[]).map((s) => [
      s,
      fixtureApprovalDetail(s),
    ]),
  );
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...styles].join("\n");
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/style.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (url.pathname !== "/") return Response.json({ data: null });
      return new Response(
        `<!doctype html><html lang="de" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="k2b-ui" style="margin:0"><div id="root"></div><script>window.approvalAdminFixtures=${JSON.stringify(adminFixtures).replace(/</g, "\\u003c")}</script><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
  setSystemTime();
});

const families = {
  capability: ["open", "sending", "done", "declined", "expired", "failed", "unknown"],
  code: [
    "waiting",
    "changes",
    "revising",
    "rejected",
    "expired",
    "ready",
    "switching",
    "activation-failed",
    "on",
    "on-without-page",
    "paused",
    "replaced",
  ],
  page: ["new-version", "approval", "changes-requested", "versions-rejected"],
  admin: ["normal", "own", "sole", "approved", "rejected", "changes", "withdrawn", "followup"],
  mixed: ["open"],
};
for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    for (const [family, states] of Object.entries(families)) {
      test(`${family}: every approval state at ${width}px in ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: width === 390 ? 780 : 900 }, reducedMotion: "reduce" });
        const errors = pageErrors(page);
        try {
          await page.addInitScript(() => {
            const at = Date.parse("2026-11-17T08:49:00.000Z");
            const Original = Date;
            globalThis.Date = new Proxy(Original, {
              construct: (target, args) => Reflect.construct(target, args.length ? args : [at]),
              get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
            });
          });
          for (const state of states) {
            await page.goto(`${assets.url.origin}/?${new URLSearchParams({ family, state, theme })}`);
            await page.locator("#following").waitFor();
            await page.evaluate(() => document.fonts.ready);
            await settled(page);
            expect(errors).toEqual([]);
            const frames = page.locator(".cloud-approval-frame");
            expect(await frames.count()).toBeGreaterThan(0);
            for (const frame of await frames.all()) {
              const geometry = await frame.evaluate((node) => {
                const title = node.querySelector(".k2b-notice-card__title")!;
                const detail = node.querySelector(".k2b-notice-card__description")!;
                const actions = [...node.querySelectorAll<HTMLElement>(".k2b-notice-card__actions > :is(button, a, .k2b-split-button)")];
                return {
                  height: node.getBoundingClientRect().height,
                  reserve: node.hasAttribute("data-reserve"),
                  gap: detail.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
                  icons: node.querySelectorAll(".k2b-notice-card__icon").length,
                  actions: actions.map((action) => ({
                    width: action.getBoundingClientRect().width,
                    top: action.getBoundingClientRect().top,
                    bottom: action.getBoundingClientRect().bottom,
                    inset: node.getBoundingClientRect().bottom - action.getBoundingClientRect().bottom,
                  })),
                };
              });
              expect(geometry.icons).toBe(1);
              expect(geometry.gap).toBeGreaterThanOrEqual(0);
              expect(geometry.gap).toBeLessThanOrEqual(4);
              expect(geometry.actions.length).toBeLessThanOrEqual(2);
              // K1: a row with a second text line is 52 px; the phone reserve is 2×20 title + 2×16 detail + 2 gap + 40 actions
              // + 12 + the row's two 8 px insets = 142 px, and the actions end on that 8 px inset.
              expect(geometry.height).toBe(width === 1440 ? 52 : geometry.reserve ? 142 : geometry.height);
              if (width === 390) for (const action of geometry.actions) expect(action.inset).toBeCloseTo(8, 0);
              if (width === 390 && geometry.actions.length === 2) {
                expect(Math.abs(geometry.actions[0]!.width - geometry.actions[1]!.width)).toBeLessThan(1);
                expect(geometry.actions[0]!.top).toBe(geometry.actions[1]!.top);
              }
            }
            if (family === "mixed") {
              const edges = await frames
                .locator(".k2b-notice-card__title")
                .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().left));
              expect(new Set(edges).size).toBe(1);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({ path: resolve(shots, `${family}-${state}-${theme}-${width}.png`), fullPage: true });
              if (
                (family === "capability" && state === "open") ||
                (family === "code" && state === "ready") ||
                (family === "page" && state === "new-version") ||
                (family === "admin" && state === "normal")
              ) {
                const primary = frames.first().locator("[data-approval-primary], [data-code-version-primary]").first();
                if (await primary.count()) {
                  await primary.focus();
                  await page.screenshot({ path: resolve(shots, `${family}-focus-${theme}-${width}.png`), fullPage: true });
                }
              }
            }
          }
        } finally {
          await page.close();
        }
      }, 180_000);
    }

for (const theme of ["light", "dark"])
  for (const width of [1440, 390]) {
    test(`a real capability answer keeps the card and following content at ${width}px in ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 780 : 900 }, reducedMotion: "reduce" });
      try {
        await page.goto(`${assets.url.origin}/?${new URLSearchParams({ family: "capability", state: "open", theme })}`);
        const frame = page.locator(".cloud-approval-frame");
        await frame.waitFor();
        await settled(page);
        const boxes = () =>
          page.evaluate(() =>
            [".cloud-approval-frame", "#following"].map((selector) => {
              const box = document.querySelector(selector)!.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            }),
          );
        const before = await boxes();
        const primary = frame.locator("[data-approval-primary]");
        await primary.focus();
        if (shots) await page.screenshot({ path: resolve(shots, `transition-before-${theme}-${width}.png`) });
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".cloud-approval-frame")?.getAttribute("data-state") === "sending");
        await settled(page);
        expect(await boxes()).toEqual(before);
        await page.evaluate(() => (window as unknown as { approvalParity: { show(state: string): void } }).approvalParity.show("done"));
        await settled(page);
        expect(await boxes()).toEqual(before);
        if (shots) await page.screenshot({ path: resolve(shots, `transition-after-${theme}-${width}.png`) });
      } finally {
        await page.close();
      }
    });
  }
