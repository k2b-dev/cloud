import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { authoringStopReasons, authoringStopSaves } from "./authoring-stop.test-fixture";

// Real Assistant CSS, typeface, icons, timeline and continuation. Fictional data, one browser at a time.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.AUTHORING_STOP_SCREENSHOTS?.trim();
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "authoring-stop.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-authoring-stop",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the pause harness.");
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
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (url.pathname === "/")
        return new Response(
          `<!doctype html><html lang="${url.searchParams.get("lang")}" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div class="app-accent-scope" data-k2b-primary="ai" style="${appColors}"><script type="module" src="/harness.js"></script></div></body></html>`,
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

type Box = { x: number; y: number; width: number; height: number };
const near = (actual: Box, expected: Box) => {
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(actual[key] - expected[key])).toBeLessThan(0.5);
};
const open = async (
  locale: "de" | "en",
  width: number,
  theme: "light" | "dark",
  reason = "input_tokens",
  save = "draft",
  mode = "ready",
) => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 780 : 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
    reducedMotion: "reduce",
    locale,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.goto(`${assets.url.origin}/?${new URLSearchParams({ lang: locale, theme, reason, save, mode })}`, { timeout: 30_000 });
  await page.waitForFunction(() => "firstRect" in window);
  await settled(page);
  return { page, errors, close: () => context.close() };
};
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as Box;
    return {
      card: box(".assistant-authoring-stop"),
      quiet: box(".assistant-authoring-stop__meta"),
      button: box(".assistant-authoring-stop button"),
    };
  });
const quiet = (page: Page) => page.locator('.assistant-authoring-stop__meta > :not([aria-hidden="true"])');
const count = (page: Page) => page.evaluate(() => (window as unknown as { continued: string[] }).continued.length);
const busy = (page: Page, value: boolean) =>
  page.evaluate((next) => (window as unknown as { setBusy: (busy: boolean) => void }).setBusy(next), value);
const finish = (page: Page, ok: boolean) =>
  page.evaluate((next) => (window as unknown as { settleSend: (ok: boolean) => void }).settleSend(next), ok);
const shot = async (page: Page, name: string, width: number) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `pause-${name}-light-${width}.png`) });
};

describe("the v10 pause card", () => {
  for (const locale of ["de", "en"] as const) {
    for (const reason of authoringStopReasons) {
      for (const save of authoringStopSaves) {
        test(`${locale}: ${reason} / ${save}, light and dark, desktop and phone`, async () => {
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) {
              const { page, errors, close } = await open(locale, width, theme, reason, save);
              try {
                const card = page.locator(".assistant-authoring-stop");
                expect(await card.getAttribute("data-tone")).toBe("neutral");
                expect(await card.locator(".k2b-chat-task-list").count()).toBe(0);
                expect(await card.locator("i").count()).toBe(1);
                expect(await card.locator(".k2b-notice-card__title").innerText()).toBe(
                  locale === "de"
                    ? `Gustav macht eine Pause.${reason === "repeated_error" ? " Ein Hinweis von dir hilft weiter." : ""}`
                    : `Gustav is taking a break.${reason === "repeated_error" ? " A hint from you will help." : ""}`,
                );
                expect(await quiet(page).innerText()).toContain(
                  locale === "de"
                    ? { none: "Noch kein Entwurf", draft: "Entwurf gespeichert, noch keine Version", version: "Version gespeichert" }[save]
                    : { none: "No draft yet", draft: "Draft saved, no version yet", version: "Version saved" }[save],
                );
                const geometry = await boxes(page);
                const first = await page.evaluate(() => (window as unknown as { firstRect: Box }).firstRect);
                near(geometry.card, first);
                const layout = await page.evaluate(() => {
                  const card = document.querySelector<HTMLElement>(".assistant-authoring-stop")!;
                  const title = card.querySelector(".k2b-notice-card__title")!;
                  const quiet = card.querySelector(".assistant-authoring-stop__meta")!;
                  const button = card.querySelector("button")!;
                  const styles = [title, quiet].map((node) => {
                    const s = getComputedStyle(node);
                    return { size: parseFloat(s.fontSize), weight: s.fontWeight, color: s.color };
                  });
                  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
                  const luminance = (color: string) => {
                    canvas.fillStyle = color;
                    canvas.fillRect(0, 0, 1, 1);
                    const [r, g, b] = [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((value) => {
                      const channel = value / 255;
                      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                    });
                    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
                  };
                  const surface = luminance(getComputedStyle(card).backgroundColor);
                  const contrast = styles.map((style) => {
                    const text = luminance(style.color);
                    return (Math.max(surface, text) + 0.05) / (Math.min(surface, text) + 0.05);
                  });
                  return {
                    styles,
                    contrast,
                    overflow: card.scrollWidth - card.clientWidth,
                    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    button: button.getBoundingClientRect().toJSON(),
                    card: card.getBoundingClientRect().toJSON(),
                    textBottom: quiet.getBoundingClientRect().bottom,
                    reducedMotion: getComputedStyle(button).transitionDuration,
                    buttonFill: getComputedStyle(button).backgroundColor,
                    expectedFill: (() => {
                      const probe = document.createElement("span");
                      probe.style.background = innerWidth === 390 ? "var(--k2b-action-solid)" : "var(--k2b-surface)";
                      card.append(probe);
                      const color = getComputedStyle(probe).backgroundColor;
                      probe.remove();
                      return color;
                    })(),
                  };
                });
                expect(layout.styles.map((style) => style.size)).toEqual([14, 13]);
                expect(layout.styles.every((style) => style.weight === "400")).toBe(true);
                for (const contrast of layout.contrast) expect(contrast).toBeGreaterThanOrEqual(4.5);
                expect(layout.buttonFill).toBe(layout.expectedFill);
                expect(layout.overflow).toBe(0);
                expect(layout.pageOverflow).toBe(0);
                for (const duration of layout.reducedMotion.split(",")) expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
                if (width === 390) {
                  expect(layout.button.y).toBeGreaterThanOrEqual(layout.textBottom);
                  expect(layout.button.width).toBeCloseTo(layout.card.width - 28, 0);
                  expect(layout.button.height).toBeGreaterThanOrEqual(40);
                } else {
                  expect(layout.button.height).toBeCloseTo(30, 0);
                }
                expect(await card.innerText()).not.toMatch(/code_|\.tsx?\b|[a-z]+_[a-z]+|Version 2/);
                expect(await count(page)).toBe(0);
                if (locale === "de" && theme === "light") await shot(page, `${reason}-${save}`, width);
                expect(errors).toEqual([]);
              } finally {
                await close();
              }
            }
        }, 90_000);
      }
    }
  }

  for (const locale of ["de", "en"] as const) {
    for (const reason of authoringStopReasons) {
      for (const save of authoringStopSaves) {
        test(`${locale}: ${reason} / ${save} keeps its geometry through blocking, sending, failure and retry`, async () => {
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) {
              const { page, errors, close } = await open(locale, width, theme, reason, save, "settling");
              try {
                const initial = await boxes(page);
                const same = async () => {
                  await settled(page);
                  const next = await boxes(page);
                  near(next.card, initial.card);
                  near(next.quiet, initial.quiet);
                  near(next.button, initial.button);
                };
                expect(await page.locator(".assistant-authoring-stop").getByRole("button").count()).toBe(0);
                await page.evaluate(() => (window as unknown as { setContinuable: (value: boolean) => void }).setContinuable(true));
                await same();
                const button = page.getByRole("button", { name: locale === "de" ? "Weiterarbeiten" : "Continue" });
                await busy(page, true);
                await same();
                expect(await button.isDisabled()).toBe(true);
                expect(await quiet(page).innerText()).toBe(
                  locale === "de" ? "Geht, sobald Gustav fertig ist." : "Available when Gustav is finished.",
                );
                const capture = locale === "de" && theme === "light" && reason === "input_tokens" && save === "draft";
                if (capture) await shot(page, "blocked", width);
                await busy(page, false);
                await settled(page);
                await button.click();
                // settled: the send intentionally stays pending until finish(page, …).
                await same();
                expect(await button.isDisabled()).toBe(true);
                expect(await count(page)).toBe(1);
                expect(await button.locator(".k2b-button__label").evaluate((label) => getComputedStyle(label).opacity)).toBe("1");
                const indicatorGap = await button.evaluate((element) => {
                  const label = element.querySelector(".k2b-button__label")!.getBoundingClientRect();
                  const indicator = element.querySelector(".k2b-button__busy i")!.getBoundingClientRect();
                  return label.left - indicator.right;
                });
                expect(indicatorGap).toBeGreaterThanOrEqual(0);
                expect(indicatorGap).toBeLessThanOrEqual(8);
                expect(await quiet(page).innerText()).toBe(locale === "de" ? "Gustav macht weiter …" : "Gustav is continuing …");
                if (capture) await shot(page, "sending", width);
                await finish(page, false);
                await page.getByRole("alert").waitFor();
                await same();
                expect(await button.isEnabled()).toBe(true);
                if (capture) await shot(page, "failed", width);
                await button.focus();
                await page.keyboard.press("Shift");
                await same();
                expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
                await page.keyboard.press("Enter");
                expect(await count(page)).toBe(2);
                await finish(page, true);
                await page
                  .getByText(locale === "de" ? "Setze die offene Arbeit fort." : "Continue the remaining work.", { exact: false })
                  .waitFor();
                await same();
                expect(await page.getByRole("button", { name: locale === "de" ? "Weiterarbeiten" : "Continue" }).count()).toBe(0);
                expect(errors).toEqual([]);
              } finally {
                await close();
              }
            }
        }, 90_000);
      }
    }
  }

  for (const theme of ["light", "dark"] as const) {
    test(`a historical receipt has no action and remains neutral (${theme})`, async () => {
      for (const width of [1440, 390]) {
        const { page, errors, close } = await open("de", width, theme, "input_tokens", "draft", "retired");
        try {
          expect(await page.locator(".assistant-authoring-stop").getByRole("button").count()).toBe(0);
          expect(await quiet(page).innerText()).toBe("Arbeitspensum der Runde erreicht · Entwurf gespeichert, noch keine Version");
          if (theme === "light") await shot(page, "retired", width);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }
    });
  }
});
