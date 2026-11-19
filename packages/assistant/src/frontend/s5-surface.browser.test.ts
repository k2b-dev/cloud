import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { FIXTURE_NOW } from "./code-overview.fixture";

// Automationen als Code v5, section 7, with the shipped Assistant CSS: nothing runs wider than a phone, the data line
// stays a quiet line of at most three, and a queue entry's state word never moves the field. Fictional data only.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.S5_SCREENSHOTS?.trim();
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  setSystemTime(new Date(FIXTURE_NOW));
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "s5-surface.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-s5-surface",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the S5 harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const outputs: string[] = [];
  for (const path of [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")]) {
    const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
    outputs.push(await output.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) =>
      readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((?!["']?(?:data:|https?:))(["']?)(?:\.\/)?/g, "url($1/ui/"),
    )
    .join("\n");
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
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
          `<!doctype html><html lang="${url.searchParams.get("lang")}" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div class="app-accent-scope" data-k2b-primary="ai" style="${appColors}"><div id="root"></div><script type="module" src="/harness.js"></script></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      // The page reads nothing else; an approval list or Code read would answer as an empty, successful page.
      return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
  setSystemTime();
});

const open = async (scene: string, width: number, theme: string, lang = "de") => {
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
  }, Date.parse(FIXTURE_NOW));
  await page.goto(`${assets.url.origin}/?${new URLSearchParams({ lang, theme, scene })}`);
  await page.waitForFunction(() => "s5Ready" in window);
  await settled(page);
  return { page, errors, close: () => context.close() };
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
const screenshot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: true });
};
const SIZES = [1440, 390] as const;
const THEMES = ["light", "dark"] as const;

describe("Automationen als Code v5 surface in a real engine", () => {
  test("the card with its chat and with a missing chat fits desktop and phone in both themes", async () => {
    for (const scene of ["apps-chat", "apps-chat-fehlt"])
      for (const width of SIZES)
        for (const theme of THEMES) {
          const h = await open(scene, width, theme);
          try {
            expect(await overflow(h.page)).toBeLessThanOrEqual(0);
            const card = h.page.locator('a[href="/app/assistant/code/c_brief1"]').first();
            expect(await card.isVisible()).toBe(true);
            // The chat belongs to the description under the name and stays inside the card at every width.
            const line = await card.evaluate((element) => {
              const description = [...element.querySelectorAll("*")].find((node) =>
                /· (in\u00a0„|Chat fehlt)/.test(node.textContent ?? ""),
              );
              const rect = description?.getBoundingClientRect();
              return rect ? { height: rect.height, right: rect.right, card: element.getBoundingClientRect().right } : null;
            });
            expect(line).not.toBeNull();
            expect(line!.right).toBeLessThanOrEqual(line!.card + 0.5);
            if (scene === "apps-chat-fehlt") expect(await card.getByText("Braucht dich").isVisible()).toBe(true);
            await screenshot(h.page, `${scene}-${theme}-${width}`);
            expect(h.errors).toEqual([]);
          } finally {
            await h.close();
          }
        }
  }, 120_000);

  test("Waiting for you names the automation and its chat and offers Choose a chat, with one tab stop per link", async () => {
    for (const width of SIZES)
      for (const theme of THEMES) {
        const h = await open("waiting", width, theme);
        try {
          expect(await overflow(h.page)).toBeLessThanOrEqual(0);
          const origin = h.page.locator(".cloud-approval__origin").first();
          expect(await origin.textContent()).toContain("Aus der Automation „Morgenbriefing“ · im Chat „Morgenbriefing“");
          const choose = h.page.getByRole("link", { name: "Chat wählen …: Morgenbriefing braucht einen Chat" });
          // The page loads the section in the browser here; its row is the test's own condition.
          await choose.waitFor();
          await settled(h.page);
          expect(await choose.isVisible()).toBe(true);
          // The way out is reachable by keyboard and shows its focus.
          await choose.focus();
          expect(await choose.evaluate((element) => element.matches(":focus-visible") || document.activeElement === element)).toBe(true);
          await settled(h.page);
          const row = await box(h.page, '[data-reason="chat_missing"]');
          const button = await choose.boundingBox();
          expect(button!.x + button!.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
          await screenshot(h.page, `waiting-${theme}-${width}`);
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 120_000);

  test("the data line stays quiet and at most three lines; the queue row keeps its place when an entry retries", async () => {
    for (const width of SIZES)
      for (const theme of THEMES) {
        const h = await open("chat", width, theme);
        try {
          expect(await overflow(h.page)).toBeLessThanOrEqual(0);
          const lines = await h.page.$$eval(".ai-message-data > span", (spans) =>
            spans.map((span) => {
              const style = getComputedStyle(span);
              return { height: span.getBoundingClientRect().height, line: Number.parseFloat(style.lineHeight), size: style.fontSize };
            }),
          );
          expect(lines).toHaveLength(2);
          for (const line of lines) {
            expect(line.size).toBe("12px");
            expect(line.height).toBeLessThanOrEqual(line.line * 3 + 0.5);
          }
          // The short data takes one line on a desktop and may wrap once in a phone's bubble; the long one is cut at three.
          expect(lines[0]!.height).toBeLessThanOrEqual(lines[0]!.line * (width < 600 ? 2 : 1) + 0.5);
          expect(lines[1]!.height).toBeGreaterThan(lines[1]!.line * 2);
          // Inside the machine-written bubble, under its instruction.
          expect(await h.page.$$eval(".ai-message-data", (rows) => rows.every((row) => row.closest('[data-source=""]') !== null))).toBe(
            true,
          );
          const field = await box(h.page, "#following");
          const pending = await box(h.page, ".assistant-queue");
          await screenshot(h.page, `chat-${theme}-${width}`);
          await h.page.evaluate(() => (window as unknown as { setQueueState(state: string): void }).setQueueState("retrying"));
          await settled(h.page);
          expect(await h.page.locator('.assistant-queue__state[data-state="retrying"]').first().isVisible()).toBe(true);
          // The short state word leaves the message its room on a phone; nothing runs past the edge.
          expect(await overflow(h.page)).toBeLessThanOrEqual(0);
          expect((await box(h.page, ".assistant-queue__next .assistant-queue__text")).width).toBeGreaterThan(0);
          expect(await box(h.page, ".assistant-queue")).toEqual(pending);
          expect(await box(h.page, "#following")).toEqual(field);
          await screenshot(h.page, `chat-retrying-${theme}-${width}`);
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 120_000);
});
