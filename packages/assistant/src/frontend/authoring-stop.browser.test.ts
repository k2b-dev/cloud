import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

// Gustav's authoring stop as people see it: one notice with title, reason, "Done" and "Still open" in the task list's
// icons, a quiet saved line and a real 36 px button. Nothing sends by itself and nothing moves: not when the card
// appears, not while it sends, not after a failed send, and not after the new turn starts below it.
// Set AUTHORING_STOP_SCREENSHOTS=<dir> to keep the light review screenshots.

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const entry = resolve(import.meta.dir, "authoring-stop.browser-harness.tsx");
const shots = process.env.AUTHORING_STOP_SCREENSHOTS?.trim();
/** Gustav's app colors as the Cloud shell scopes them (see AssistantGustav.browser.test.ts). */
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;" +
  "--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";

let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the authoring stop harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")].map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  // Icons and the typeface come from @k2b/ui's build, so the card measures as it does in Cloud.
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
          `<!doctype html><html lang="${url.searchParams.get("lang")}" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head>` +
            `<body class="k2b-ui" style="margin:0"><div class="app-accent-scope" style="${appColors}">` +
            `<script type="module" src="/harness.js"></script></div></body></html>`,
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

const open = async (locale: "de" | "en", width: number, theme: "light" | "dark" = "light") => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
    reducedMotion: "reduce",
    locale,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.goto(`${assets.url.origin}/?lang=${locale}&theme=${theme}`, { timeout: 30_000 });
  await page.waitForFunction(() => "firstRect" in window);
  await settled(page);
  return { page, errors, close: () => context.close() };
};

const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as Box;
    return { card: box(".assistant-authoring-stop"), button: box(".assistant-authoring-stop .k2b-button") };
  });

const continued = (page: Page) => page.evaluate(() => (window as unknown as { continued: string[] }).continued.length);

describe("Gustav's authoring stop", () => {
  for (const locale of ["de", "en"] as const) {
    test(`reads as one notice with two lists and a real button in ${locale}`, async () => {
      for (const width of [1440, 390]) {
        const { page, errors, close } = await open(locale, width);
        try {
          const de = locale === "de";
          const card = page.locator(".assistant-authoring-stop");
          expect(await card.locator(".k2b-notice-card__title").textContent()).toBe(de ? "Gustav hat angehalten" : "Gustav stopped");
          expect(await card.locator(".k2b-notice-card__description").textContent()).toBe(
            de ? "Dasselbe Problem blieb nach mehreren Versuchen." : "The same problem remained after several attempts.",
          );
          const done = page.getByRole("list", { name: de ? "Erledigt" : "Done" });
          const open = page.getByRole("list", { name: de ? "Noch offen" : "Still open" });
          expect(await done.locator("li").allTextContents()).toEqual(de ? ["Entwurf geprüft"] : ["Draft checked"]);
          expect(await open.locator("li").allTextContents()).toEqual(
            de ? ["Mit Beispielen testen", "Version speichern"] : ["Test with examples", "Save a version"],
          );
          expect(await done.locator("li > i.ti-check").count()).toBe(1);
          expect(await open.locator("li > i.ti-circle").count()).toBe(2);
          expect(await card.locator(".assistant-authoring-stop__meta").innerText()).toBe(
            de ? "Der Entwurf ist gespeichert." : "The draft is saved.",
          );
          const button = page.getByRole("button", { name: de ? "Weiterarbeiten" : "Continue" });
          expect(await button.getAttribute("data-variant")).toBe("secondary");
          expect((await button.boundingBox())!.height).toBeCloseTo(36, 0);
          // No code, file names or error codes.
          expect(await card.innerText()).not.toMatch(/code_|\.tsx?\b|[a-z]+_[a-z]+/);

          const layout = await page.evaluate(() => {
            const card = document.querySelector(".assistant-authoring-stop")!;
            const button = card.querySelector(".k2b-button")!;
            const styles = new Set<string>();
            const sizes = new Set<number>();
            for (const node of card.querySelectorAll<HTMLElement>("p, li > span, .k2b-button, .k2b-button *")) {
              if (!node.textContent?.trim() || [...node.children].some((child) => child.textContent?.trim())) continue;
              const style = getComputedStyle(node);
              sizes.add(Number.parseFloat(style.fontSize));
              if (!button.contains(node)) styles.add(`${style.fontSize}/${style.fontWeight}/${style.color}`);
            }
            const title = card.querySelector(".k2b-notice-card__title")!;
            const range = document.createRange();
            range.selectNodeContents(title);
            const icons = [...card.querySelectorAll("li > i")].map((icon) => icon.getBoundingClientRect());
            return {
              styles: [...styles],
              sizes: [...sizes],
              textEdge: range.getBoundingClientRect().left,
              iconLefts: icons.map((icon) => icon.left),
              iconCenters: icons.map((icon) => icon.left + icon.width / 2),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              cardOverflow: card.scrollWidth - card.clientWidth,
            };
          });
          // Title and entries, plus one quiet level: at most three text styles, sizes only from 12/13/14/18.
          expect(layout.styles.length).toBeLessThanOrEqual(3);
          for (const size of layout.sizes) expect([12, 13, 14, 18]).toContain(size);
          // Every icon on one axis, on the text edge of title and reason.
          for (const center of layout.iconCenters) expect(Math.abs(center - layout.iconCenters[0]!)).toBeLessThan(0.5);
          expect(Math.abs(layout.iconLefts[0]! - layout.textEdge)).toBeLessThan(1);
          expect(layout.overflow).toBe(0);
          expect(layout.cardOverflow).toBe(0);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: resolve(shots, `budget-stop-${locale}-light-${width}.png`) });
          }
          expect(await continued(page)).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      }
    }, 90_000);
  }

  test("keeps its place when it appears, while it sends, after a failed send and after the new turn starts", async () => {
    for (const width of [1440, 390]) {
      const { page, errors, close } = await open("de", width);
      try {
        const first = await page.evaluate(() => (window as unknown as { firstRect: Box }).firstRect);
        const initial = await boxes(page);
        near(initial.card, first);
        expect(await continued(page)).toBe(0);

        const button = page.getByRole("button", { name: "Weiterarbeiten" });
        await button.click();
        expect(await continued(page)).toBe(1);
        // settled: the pending send is the subject; it stays pending until the test settles it.
        const sending = await boxes(page);
        near(sending.card, initial.card);
        near(sending.button, initial.button);

        await page.evaluate(() => (window as unknown as { settleSend: (ok: boolean) => void }).settleSend(false));
        expect(await page.getByRole("alert").innerText()).toBe("Das ging nicht. Versuch es noch einmal.");
        await settled(page);
        const failed = await boxes(page);
        near(failed.card, initial.card);
        near(failed.button, initial.button);
        expect(await button.isEnabled()).toBe(true);
        // The recovery line reads on the warning surface: at least 4.5:1, measured from the painted colors.
        const contrast = await page.evaluate(() => {
          const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
          const rgb = (color: string) => {
            canvas.clearRect(0, 0, 1, 1);
            canvas.fillStyle = color;
            canvas.fillRect(0, 0, 1, 1);
            return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
          };
          const luminance = (color: string) => {
            const [r, g, b] = rgb(color).map((value) => {
              const channel = value / 255;
              return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          // The card's tint over the page behind it, as painted.
          const card = getComputedStyle(document.querySelector(".assistant-authoring-stop")!).backgroundColor;
          for (const layer of [
            "#fff",
            getComputedStyle(document.documentElement).backgroundColor,
            getComputedStyle(document.body).backgroundColor,
          ]) {
            canvas.fillStyle = layer;
            canvas.fillRect(0, 0, 1, 1);
          }
          canvas.fillStyle = card;
          canvas.fillRect(0, 0, 1, 1);
          const surface = `rgb(${[...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",")})`;
          const [light, dark] = [luminance(getComputedStyle(document.querySelector('[role="alert"]')!).color), luminance(surface)].sort(
            (a, b) => b - a,
          );
          return (light! + 0.05) / (dark! + 0.05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: resolve(shots, `budget-stop-failed-de-light-${width}.png`) });
        }

        // The keyboard path: focus and Enter send once; the new request lands below the card.
        await button.focus();
        await page.keyboard.press("Enter");
        expect(await continued(page)).toBe(2);
        await page.evaluate(() => (window as unknown as { settleSend: (ok: boolean) => void }).settleSend(true));
        await page.getByText("Setze die offene Arbeit fort.", { exact: false }).waitFor();
        await settled(page);
        const after = await boxes(page);
        near(after.card, initial.card);
        near(after.button, initial.button);
        expect(await button.isDisabled()).toBe(true);
        expect(await page.getByRole("alert").innerText()).toBe("");
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 90_000);

  test("keeps tone and contrast in dark mode", async () => {
    const { page, errors, close } = await open("en", 1440, "dark");
    try {
      const colors = await page.evaluate(() => {
        const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
        return { title: color(".k2b-notice-card__title"), item: color(".assistant-authoring-stop__list li") };
      });
      // Light ink on the dark surface, never the light theme's near-black.
      for (const value of Object.values(colors)) expect(value).not.toMatch(/^rgb\((?:[0-6]?\d|9), /);
      if (shots) await page.screenshot({ path: resolve(shots, "budget-stop-en-dark-1440.png") });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});
