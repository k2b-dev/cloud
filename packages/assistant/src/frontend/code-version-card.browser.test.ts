import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { approvalNow, approvalStates } from "./code-version-card.test-fixture";

// Real Assistant CSS, typeface, icons, timeline and continuation. Fictional data, one browser at a time.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.APPROVAL_CARD_SCREENSHOTS?.trim();
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "code-version-card.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-approval-card",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the approval harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const outputs: string[] = [];
  for (const path of [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")]) {
    const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
    outputs.push(await output.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const preloads = [...fonts.matchAll(/url\(["']?([^"')]+\.woff2)/g)]
    .map((match) => match[1]!)
    .filter((path) => /\/(?:ibm-plex-sans-latin-(?:400|600)-normal-|tabler-icons-)/.test(path))
    .map((path) => `<link rel="preload" href="${path}" as="font" type="font/woff2" crossorigin>`)
    .join("");
  const cache = { "cache-control": "public, max-age=3600" };
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript", ...cache } });
      if (url.pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css", ...cache } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))), { headers: cache });
      if (url.pathname === "/")
        return new Response(
          `<!doctype html><html lang="${url.searchParams.get("lang")}" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${preloads}<link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div class="app-accent-scope" data-k2b-primary="ai" style="${appColors}"><script type="module" src="/harness.js"></script></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      return new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
});

const open = async (width: number, theme: string, lang = "de", mode = "states") => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 780 : 900 },
    locale: lang,
    reducedMotion: "reduce",
    isMobile: width < 600,
    hasTouch: width < 600,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [at], newTarget),
      apply: () => new RealDate(at).toString(),
      get: (target, property) => (property === "now" ? () => at : Reflect.get(target, property)),
    });
  }, Date.parse(approvalNow));
  await page.goto(`${assets.url.origin}/?${new URLSearchParams({ lang, theme, mode })}`);
  await page.waitForFunction(() => "setApprovalState" in window);
  await settled(page);
  return { page, errors, close: () => context.close() };
};
const setState = async (page: Page, state: string) => {
  await page.evaluate((state) => (window as unknown as { setApprovalState(state: string): void }).setApprovalState(state), state);
  await settled(page);
};
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      card: box(".assistant-code-version"),
      main: box(".k2b-notice-card__head"),
      quiet: box(".k2b-notice-card__body"),
      next: box("#following"),
    };
  });
const screenshot = async (page: Page, name: string, theme: string, width: number) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `approval-${name}-${theme}-${width}.png`) });
};

describe("v10 approval card in Chromium", () => {
  test("all twelve states stay in place in light/dark on desktop/phone; phone actions share width", async () => {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const h = await open(width, theme);
        try {
          const first = await boxes(h.page);
          for (const state of [...approvalStates, "loading", "failed", "denied"]) {
            await setState(h.page, state);
            const measured = await boxes(h.page);
            expect({ state, measured }).toEqual({ state, measured: first });
            const card = h.page.locator(".assistant-code-version");
            expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            expect(await card.locator(".k2b-notice-card__icon").count()).toBe(1);
            expect(await card.locator(".k2b-chat-decision__details").count()).toBe(0);
            const actions = card.locator(".assistant-code-version__action");
            const count = await actions.count();
            expect(count).toBeLessThanOrEqual(2);
            if (width === 390 && count) {
              const row = (await card.locator(".assistant-code-version__actions").boundingBox())!;
              const a = (await actions.first().boundingBox())!;
              if (count === 1) expect(Math.abs(a.width - row.width)).toBeLessThan(0.5);
              else {
                const b = (await actions.nth(1).boundingBox())!;
                expect(Math.abs(a.width - b.width)).toBeLessThan(0.5);
                expect(a.x).toBeLessThan(b.x);
                expect(await actions.first().locator(".k2b-button").getAttribute("data-variant")).toBe("secondary");
              }
              expect(a.y).toBeGreaterThanOrEqual(measured.quiet.y + measured.quiet.height);
              expect(await card.locator("[data-code-version-primary]").getAttribute("data-variant")).toBe("ai");
            }
            if (state === "on") expect(await card.locator(".k2b-split-button").count()).toBe(1);
            else expect(await card.getByRole("button", { name: "Öffnen", exact: true }).count()).toBe(0);
            await screenshot(h.page, state, theme, width);
          }
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 120_000);

  test("event jump focuses the main control on both widths; SplitButton offers only the other projected pages", async () => {
    for (const width of [1440, 390]) {
      const h = await open(width, "light");
      try {
        await setState(h.page, "ready");
        await h.page.getByRole("button", { name: "Zur Karte", exact: true }).click();
        expect(await h.page.locator("[data-code-version-primary]").evaluate((element) => element === document.activeElement)).toBe(true);
        await screenshot(h.page, "focus-jump", "light", width);
        await setState(h.page, "on");
        const menu = h.page.getByRole("button", { name: "Weitere Seiten", exact: true });
        await menu.focus();
        await h.page.keyboard.press("Enter");
        await h.page.getByRole("menuitem", { name: "Monatsübersicht", exact: true }).waitFor();
        expect(await h.page.getByRole("menuitem", { name: "Einstellungen", exact: true }).getAttribute("href")).toBe(
          "/code/c_info01/settings",
        );
        expect(await h.page.getByRole("menuitem", { name: "Lieferscheine", exact: true }).count()).toBe(0);
        if (width === 390) expect(await h.page.locator(".k2b-gesture-menu__sheet-menu").count()).toBeGreaterThan(0);
        await screenshot(h.page, "pages", "light", width);
        await h.page.keyboard.press("Escape");
        await h.page.locator("[data-code-version-primary]").click();
        await h.page.waitForURL("**/code/c_info01/home");
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);

  test("keyboard activation retains focus after failure and the phone leaves no room change", async () => {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const h = await open(width, theme, "de", "interactive");
        try {
          await h.page.locator(".assistant-code-version[data-state=ready]").waitFor();
          const first = await boxes(h.page);
          const primary = h.page.locator("[data-code-version-primary]");
          await primary.focus();
          await h.page.keyboard.press("Enter");
          await h.page.locator(".assistant-code-version[data-state=switching]").waitFor();
          expect(await boxes(h.page)).toEqual(first);
          await h.page.evaluate(() => (window as unknown as { failActivation(): void }).failActivation());
          await h.page.getByRole("alert").filter({ hasText: "Einschalten hat nicht geklappt." }).waitFor();
          // No focus() after answering the failure: the component must restore it.
          expect(await h.page.locator("[data-code-version-primary]").evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await boxes(h.page)).toEqual(first);
          await screenshot(h.page, "failure-focus", theme, width);
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 60_000);

  test("English remains readable at phone width", async () => {
    const h = await open(390, "light", "en");
    try {
      for (const state of approvalStates) {
        await setState(h.page, state);
        expect(await h.page.locator(".assistant-code-version").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);
});
