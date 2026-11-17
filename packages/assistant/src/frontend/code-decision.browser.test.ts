import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { solidTestPlugin } from "../../../ui/test/solid-test-plugin";
import type { CodeDecisionPages } from "./code-decision-pages";

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const pageLink = (path: string, title: string) => ({
  entrypoint: `GET:${path}`,
  path,
  title,
  isRoot: path === "/",
  href: `/code/c_delivery${path}`,
});
const home = pageLink("/", "Lieferscheine");
const handoff = (multiple = false): CodeDecisionPages => ({
  title: "Lieferungen",
  pages: {
    versionId: "v_demo",
    homeUrl: home.href,
    pages: [home, ...(multiple ? [pageLink("/month", "Monatsübersicht"), pageLink("/settings", "Einstellungen")] : [])],
  },
});
const shots = process.env.GUSTAV_SCREENSHOTS?.trim();
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let css: string;
let script: string;
beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "code-decision.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [solidTestPlugin("dom")],
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not build the page handoff fixture");
  script = await built.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const styles: string[] = [];
  for (const path of [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")]) {
    const built = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
    if (!built.success) throw new AggregateError(built.logs, "Could not build page handoff styles");
    styles.push(await built.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  css = [fonts, "@layer properties, theme, base, components, utilities;", ...styles].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (url.pathname === "/fixture.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (url.pathname.startsWith("/code/")) return new Response("Opened the fictional page");
      const mode = url.searchParams.get("mode") ?? "one";
      const fixture = {
        locale: url.searchParams.get("locale") ?? "de",
        ...(mode.startsWith("dynamic")
          ? {
              pageCount: mode.includes("multiple") ? 3 : mode === "dynamic-none" ? 0 : 1,
              deferred: true,
              replaced: mode === "dynamic-replaced",
            }
          : { pages: mode === "none" ? null : handoff(mode === "multiple") }),
      };
      return new Response(
        `<!doctype html><html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}" lang="${fixture.locale}" data-theme="${url.searchParams.get("theme") === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script>window.decisionFixture=${JSON.stringify(fixture)}</script><script src="/fixture.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser({ serveShellCatalog: true });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
async function pinnedPage(width = 390): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 780 : 900 }, reducedMotion: "reduce" });
  // Pin Date only; timers and animation frames keep running normally.
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [at], newTarget),
      apply: () => new RealDate(at).toString(),
      get: (target, property) => (property === "now" ? () => at : Reflect.get(target, property)),
    });
  }, Date.parse("2026-11-17T10:00:00Z"));
  return page;
}
async function open(mode: string, width = 390, theme = "light", locale = "de"): Promise<Page> {
  const page = await pinnedPage(width);
  await page.goto(`${server.url}?mode=${mode}&theme=${theme}&locale=${locale}`);
  await page.locator(".assistant-code-decision__text").waitFor();
  await settled(page);
  return page;
}

test("one and several pages keep the shared card typography, one icon and no horizontal overflow", async () => {
  const sentences = new Map<string, number>();
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const mode of ["one", "multiple", "none"]) {
        const page = await open(mode, width, theme);
        try {
          const card = page.locator(".assistant-code-decision__pages .k2b-link-card");
          expect(await card.count()).toBe(mode === "none" ? 0 : 1);
          const sentence = (await page.locator(".assistant-code-decision__text").boundingBox())!.y;
          const key = `${theme}-${width}`;
          const previous = sentences.get(key);
          if (previous !== undefined) expect(sentence).toEqual(previous);
          else sentences.set(key, sentence);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
          expect(await page.locator(".assistant-code-decision").innerText()).not.toContain("c_delivery");
          if (mode !== "none") {
            expect(await card.locator("i").count()).toBe(1);
            expect(await card.innerText()).toContain("Öffnen");
            expect(await card.innerText()).toContain("Startseite");
            expect(await card.locator(".k2b-link-card__title").evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("nowrap");
            const typography = await card.evaluate((node) =>
              ["title", "description", "meta"].map((part) => {
                const style = getComputedStyle(node.querySelector(`.k2b-link-card__${part}`)!);
                return { size: style.fontSize, weight: style.fontWeight };
              }),
            );
            expect(typography).toEqual([
              { size: "14px", weight: "600" },
              { size: "12px", weight: "400" },
              { size: "12px", weight: "600" },
            ]);
            const before = await card.boundingBox();
            await page.keyboard.press("Tab");
            expect(await card.evaluate((node) => node === document.activeElement)).toBe(true);
            if (shots && mode === "multiple") {
              await page.screenshot({ path: resolve(shots, `gl-focus-card-${theme}-${width}.png`) });
              await page.keyboard.press("Tab");
              expect(
                await page
                  .locator(".assistant-code-decision__more a")
                  .first()
                  .evaluate((node) => node === document.activeElement),
              ).toBe(true);
              await page.screenshot({ path: resolve(shots, `gl-focus-links-${theme}-${width}.png`) });
            }
            await hoverInPlace(card);
            await settled(page);
            expect(await card.boundingBox()).toEqual(before);
            expect(await card.getAttribute("href")).toBe(home.href);
            await page.locator(":focus").evaluateAll((nodes) => {
              for (const node of nodes) if (node instanceof HTMLElement) node.blur();
            });
            await page.mouse.move(0, 0);
            await settled(page);
          }
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: resolve(shots, `gl-${mode}-${theme}-${width}.png`) });
          }
          expect(pageErrors(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }
}, 60_000);

test("current rights gate a live event; failed reads offer retry and Open navigates to the supplied href", async () => {
  for (const status of [403, 404, 500, 200]) {
    const page = await pinnedPage();
    let attempts = 0;
    await page.route("**/api/code/activation/preview", (route) => {
      attempts++;
      return route.fulfill({
        status: attempts === 1 ? status : 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { title: "Lieferungen", pages: handoff().pages } }),
      });
    });
    try {
      await page.goto(`${server.url}?mode=dynamic`);
      const pending = page.locator(".assistant-code-decision__pages-pending");
      const card = page.locator(".k2b-link-card");
      if (status === 500) {
        await pending.getByRole("button", { name: "Erneut versuchen" }).click();
      }
      if (status === 200 || status === 500) {
        await card.waitFor();
        await card.click();
        expect(new URL(page.url()).pathname).toBe(home.href);
      } else {
        await pending.waitFor({ state: "detached" });
        expect(await card.count()).toBe(0);
      }
      expect(attempts).toBe(status === 500 ? 2 : 1);
      expect(pageErrors(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }
});

test("English and reduced motion preserve the same complete link", async () => {
  const page = await open("multiple", 390, "light", "en");
  try {
    expect(await page.locator(".k2b-link-card").innerText()).toContain("Open");
    expect(await page.locator(".k2b-link-card").innerText()).toContain("Home page");
    expect(await page.locator(".assistant-code-decision__more").innerText()).toContain("More pages:");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  } finally {
    await page.close();
  }
});

test("placeholder, failure and ready handoff preserve the sentence row and the full page height", async () => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const multiple of [false, true]) {
        const page = await pinnedPage(width);
        const gate = Promise.withResolvers<void>();
        let attempts = 0;
        await page.route("**/api/code/activation/preview", async (route) => {
          attempts++;
          if (attempts === 1) await gate.promise;
          await route.fulfill({
            status: attempts === 1 ? 500 : 200,
            contentType: "application/json",
            body: JSON.stringify({ data: handoff(multiple) }),
          });
        });
        try {
          await page.goto(`${server.url}?mode=${multiple ? "dynamic-multiple" : "dynamic"}&theme=${theme}`);
          const pending = page.locator(".assistant-code-decision__pages-pending");
          await pending.waitFor();
          await settled(page);
          const before = await page.locator("main").boundingBox();
          const sentenceRow = await page.locator(".assistant-code-decision__placeholder-sentence").boundingBox();
          expect(await page.locator(".assistant-code-decision__text").count()).toBe(0);
          if (shots && !multiple) await page.screenshot({ path: resolve(shots, `gl-loading-${theme}-${width}.png`) });
          gate.resolve();
          const retry = pending.getByRole("button", { name: "Erneut versuchen" });
          await retry.waitFor();
          await settled(page);
          const sentence = page.locator(".assistant-code-decision__text");
          const failedSentence = await sentence.boundingBox();
          expect(failedSentence?.y).toBeGreaterThanOrEqual(sentenceRow!.y);
          expect(failedSentence!.y + failedSentence!.height).toBeLessThanOrEqual(sentenceRow!.y + sentenceRow!.height);
          expect(await page.locator("main").boundingBox()).toEqual(before);
          if (width === 390) {
            const button = await retry.boundingBox(),
              text = await pending.locator("span").first().boundingBox(),
              block = await pending.boundingBox();
            expect(button!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
            expect(button!.width).toBe(block!.width);
          }
          if (shots && !multiple) await page.screenshot({ path: resolve(shots, `gl-failed-${theme}-${width}.png`) });
          await retry.click();
          await page.locator(".k2b-link-card").waitFor();
          await settled(page);
          expect(await page.locator("main").boundingBox()).toEqual(before);
          expect(await sentence.boundingBox()).toEqual(failedSentence);
          expect(attempts).toBe(2);
        } finally {
          gate.resolve();
          await page.close();
        }
      }
}, 60_000);

test("a successful initial read shows the finished line once; replaced activations never read or show pages", async () => {
  for (const mode of ["dynamic", "dynamic-multiple", "dynamic-replaced", "dynamic-none"]) {
    const page = await pinnedPage();
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    await page.route("**/api/code/activation/preview", async (route) => {
      reads++;
      await gate.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: handoff(mode === "dynamic-multiple") }),
      });
    });
    try {
      await page.goto(`${server.url}?mode=${mode}`);
      if (mode === "dynamic-replaced" || mode === "dynamic-none") {
        await page.locator(".assistant-code-decision__text").waitFor();
        expect(reads).toBe(0);
        expect(await page.locator(".assistant-code-decision__pages").count()).toBe(0);
      } else {
        await page.locator(".assistant-code-decision__pages-pending").waitFor();
        await settled(page);
        const before = await page.locator("main").boundingBox();
        expect(await page.locator(".assistant-code-decision__text").count()).toBe(0);
        gate.resolve();
        await page.locator(".k2b-link-card").waitFor();
        await settled(page);
        expect(await page.locator("main").boundingBox()).toEqual(before);
        expect(await page.locator(".assistant-code-decision__text").count()).toBe(1);
      }
      expect(pageErrors(page)).toEqual([]);
    } finally {
      gate.resolve();
      await page.close();
    }
  }
});
