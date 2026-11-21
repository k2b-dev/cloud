import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

// The Secret card of mockup v4 in Chromium with the real Assistant CSS, typeface and icons. Every state of one card
// keeps one geometry; on a phone both answers share one row, without icons, each label on one line.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.SECRET_CARD_SCREENSHOTS?.trim();
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "secret-card.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-secret-card",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the secret card harness.");
  const scripts = new Map<string, string>();
  for (const output of build.outputs) scripts.set(`/${output.path.replace(/^\.\//, "")}`, await output.text());
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
  const entry = [...scripts.keys()].find((path) => path.includes("secret-card.browser-harness"))!;
  const cache = { "cache-control": "public, max-age=3600" };
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const script = scripts.get(url.pathname);
      if (script) return new Response(script, { headers: { "content-type": "text/javascript", ...cache } });
      if (url.pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css", ...cache } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))), { headers: cache });
      if (url.pathname === "/")
        return new Response(
          `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div class="app-accent-scope" style="${appColors}"><div id="root"></div></div><script type="module" src="${entry}"></script></body></html>`,
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

const open = async (width: number) => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    locale: "de",
    reducedMotion: "reduce",
    isMobile: width < 600,
    hasTouch: width < 600,
    deviceScaleFactor: width < 600 ? 2 : 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.goto(assets.url.origin);
  await page.waitForFunction(() => "showSecretScene" in window);
  return { page, errors, close: () => context.close() };
};
const show = async (page: Page, id: string, reload = false) => {
  await page.evaluate(([id, reload]) => window.showSecretScene(String(id), { reload: Boolean(reload) }), [id, reload] as const);
  await page.waitForSelector(".k2b-chat-decision, .k2b-chat-outcome, .assistant-waiting__entry, #following");
  await settled(page);
};
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }, selector);

/** States one card passes through without a reload: they share one geometry. */
const families = {
  "chat, new": ["a-neu", "a-tippt", "speichert", "f-leer", "f-ungueltig", "f-speichern", "anderswo", "zu-lang+"],
  "chat, replace": ["b-ersetzen", "konflikt"],
  "automation, new": ["c-neu", "c-tippt", "c-speichert", "c-leer", "c-ungueltig", "c-speichern", "c-unklar", "c-anderswo", "c-bad-input+"],
  "automation, replace": ["c-ersetzen", "c-konflikt"],
} as const;
const MOCKUP = [
  "a-neu",
  "a-tippt",
  "b-ersetzen",
  "speichert",
  "gespeichert",
  "b-ersetzt",
  "abgelehnt",
  "f-leer",
  "f-ungueltig",
  "f-recht",
  "f-speichern",
  "konflikt",
  "anderswo",
  "abgelaufen",
  "wartet",
  "c-neu",
  "c-tippt",
  "c-ersetzen",
  "c-speichert",
  "c-gespeichert",
  "c-ersetzt",
  "c-abgelehnt",
  "c-leer",
  "c-ungueltig",
  "c-nicht-verwaltet",
  "c-recht",
  "c-speichern",
  "c-unklar",
  "c-konflikt",
  "c-geloescht",
  "c-anderswo",
  "c-abgelaufen",
  "c-wartet",
];

describe("Secret card in Chromium", () => {
  for (const width of [1440, 390])
    test(`no state of a card moves anything at ${width} px; the phone keeps both answers in one row`, async () => {
      const h = await open(width);
      try {
        for (const [family, ids] of Object.entries(families)) {
          let first: { card: Awaited<ReturnType<typeof box>>; following: Awaited<ReturnType<typeof box>> } | undefined;
          for (const id of ids) {
            await show(h.page, id);
            const measured = { card: await box(h.page, ".k2b-chat-decision"), following: await box(h.page, "#following") };
            first ??= measured;
            expect({ family, id, ...measured }).toEqual({ family, id, card: first.card, following: first.following });
            const confirm = (await box(h.page, ".k2b-chat-decision__confirm"))!;
            const decline = (await box(h.page, ".k2b-chat-decision__decline"))!;
            const field = (await box(h.page, ".k2b-chat-decision__field"))!;
            const labels = await h.page.$$eval(".k2b-chat-decision__answer .k2b-chat-decision__face[data-current='true']", (faces) =>
              faces.map((face) => ({
                lines: Math.round(face.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(face).lineHeight)),
                icons: [...face.querySelectorAll("i")].filter((icon) => getComputedStyle(icon).display !== "none").length,
              })),
            );
            if (width === 390) {
              // Both answers share one row in equal halves under the field, without icons, each label on one line.
              expect({ id, row: Math.abs(confirm.y - decline.y) < 0.5, halves: Math.abs(confirm.width - decline.width) < 0.5 }).toEqual({
                id,
                row: true,
                halves: true,
              });
              expect(confirm.y).toBeGreaterThan(field.y + field.height);
              expect(labels.map((label) => label.icons)).toEqual([0, 0]);
            } else expect(Math.abs(confirm.y - field.y)).toBeLessThan(8);
            expect({ id, lines: labels.map((label) => label.lines) }).toEqual({ id, lines: [1, 1] });
            // The eye: a fixed name and its state, 44 px on touch.
            const eye = h.page.locator(".k2b-chat-decision__field button").first();
            expect(await eye.getAttribute("aria-pressed")).toMatch(/true|false/);
            if (width === 390) expect((await eye.boundingBox())!.width).toBeGreaterThanOrEqual(44);
            expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          }
        }
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }, 120_000);

  test("screenshots of every mockup state, light, at 1440 and 390 px", async () => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    for (const width of [1440, 390]) {
      const h = await open(width);
      try {
        for (const [index, id] of MOCKUP.entries()) {
          await show(h.page, id);
          await h.page.screenshot({ path: resolve(shots, `${String(index + 1).padStart(2, "0")}-${id}-light-${width}.png`) });
        }
        for (const id of ["gespeichert", "c-gespeichert", "c-recht"]) {
          await show(h.page, id, true);
          await h.page.screenshot({ path: resolve(shots, `reload-${id}-light-${width}.png`) });
        }
      } finally {
        await h.close();
      }
    }
  }, 180_000);
});
