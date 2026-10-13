import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// Ellipsis, row height and hover stability need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the list uses its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./FileList.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-list-test",
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
  if (!build.success) throw new AggregateError(build.logs, "File list harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, theme: "light" | "dark" = "light", lang = "en") => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://file-list.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://file-list.test/");
  await tab.waitForFunction(() => !!document.querySelector(".filesv2-list__row--up"));
  return tab;
};

const boxes = (tab: Page) =>
  tab.$eval(".filesv2-list__row--up", (row) =>
    [row, ...row.querySelectorAll("[role=gridcell]")].map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

describe("parent folder row in a browser", () => {
  for (const lang of ["en", "de"]) {
    for (const [device, options] of [
      ["desktop", desktop],
      ["phone", phone],
    ] as const) {
      test(`${lang} ${device}: parent detail truncates in one ordinary-height row without moving on hover`, async () => {
        const tab = await open(options, "light", lang);
        try {
          await tab.evaluate(() => document.fonts.ready);
          const label = lang === "de" ? "Übergeordneter Ordner" : "Parent folder";
          expect(await tab.locator(".filesv2-list__row").first().getAttribute("class")).toContain("filesv2-list__row--up");
          expect(await tab.textContent(".filesv2-list__row--up .filesv2-list__name")).toBe(label);
          const layout = await tab.$eval(".filesv2-list", (list) => {
            const row = list.querySelector<HTMLElement>(".filesv2-list__row--up")!;
            const ordinary = list.querySelector<HTMLElement>(".filesv2-list__row:not(.filesv2-list__row--virtual)")!;
            const name = row.querySelector<HTMLElement>(".filesv2-list__name")!;
            const detail = row.querySelector<HTMLElement>(".filesv2-list__detail")!;
            const nameBox = name.getBoundingClientRect();
            const detailBox = detail.getBoundingClientRect();
            const style = getComputedStyle(detail);
            const iconBox = (element: HTMLElement) => {
              const { left, width, height } = element.querySelector(".filesv2-list__cell--icon > *")!.getBoundingClientRect();
              return { left, width, height };
            };
            return {
              icon: iconBox(row),
              ordinaryIcon: iconBox(ordinary),
              rowHeight: row.getBoundingClientRect().height,
              ordinaryHeight: ordinary.getBoundingClientRect().height,
              nameTop: nameBox.top,
              detailTop: detailBox.top,
              nameHeight: nameBox.height,
              detailHeight: detailBox.height,
              nameWidth: nameBox.width,
              detailWidth: detailBox.width,
              nameFits: name.scrollWidth <= name.clientWidth,
              nameColor: getComputedStyle(name).color,
              detailColor: style.color,
              whiteSpace: style.whiteSpace,
              overflow: style.overflowX,
              textOverflow: style.textOverflow,
              truncated: detail.scrollWidth > detail.clientWidth,
              listOverflow: list.scrollWidth - list.clientWidth,
              pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          });
          expect(layout.rowHeight).toBe(layout.ordinaryHeight);
          expect(layout.rowHeight).toBeGreaterThan(0);
          // Its icon takes the entries' slot, so the icon column lines up.
          expect(layout.icon).toEqual(layout.ordinaryIcon);
          expect(layout.nameTop).toBe(layout.detailTop);
          expect(layout.nameHeight).toBe(layout.detailHeight);
          expect(layout.nameWidth).toBeGreaterThan(0);
          expect(layout.detailWidth).toBeGreaterThan(0);
          expect(layout.nameFits).toBe(true);
          expect(layout.detailColor).not.toBe(layout.nameColor);
          expect(layout.whiteSpace).toBe("nowrap");
          expect(layout.overflow).toBe("hidden");
          expect(layout.textOverflow).toBe("ellipsis");
          expect(layout.truncated).toBe(true);
          expect(layout.listOverflow).toBeLessThanOrEqual(0);
          expect(layout.pageOverflow).toBeLessThanOrEqual(0);
          const before = await boxes(tab);
          await tab.locator(".filesv2-list__row--up").hover();
          expect(await boxes(tab)).toEqual(before);
          await tab.getByRole("button", { name: lang === "de" ? "Auswählen" : "Select" }).click();
          await tab.waitForSelector('.filesv2-list[data-selecting="true"]');
          expect(await tab.locator('.filesv2-list__row--up input[type="checkbox"], .filesv2-list__row--up [role="checkbox"]').count()).toBe(
            0,
          );
          expect(await tab.locator('.filesv2-list__row:not(.filesv2-list__row--virtual) input[type="checkbox"]').count()).toBe(3);
          expect((await boxes(tab))[0]!.height).toBe(layout.ordinaryHeight);
        } finally {
          await tab.context().close();
        }
      });
    }
  }
});
