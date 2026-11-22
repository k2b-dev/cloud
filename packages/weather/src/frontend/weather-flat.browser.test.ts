import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// Cloud flach (K1, K2, K15): the weather workspace as the server renders it, with the global and the app stylesheet
// and the shared workspace controller. Nothing overlaps, spills, is cut, draws a double line, or scrolls sideways, at
// 1440 and 390 px, with a short page and with a long one that scrolls. Every place and reading is invented.
const packageCache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "weather-flat-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: WeatherFlatFixture } = await import("./weather-flat.browser-fixture");
type Scenario = Parameters<typeof WeatherFlatFixture>[0]["scenario"];

setDefaultTimeout(30_000);
let browser: Browser;
let css: string;
let controller: string;
// `WEATHER_FLAT_SHOTS=<dir>` also saves light screenshots for the design review.
const shots = process.env.WEATHER_FLAT_SHOTS;

beforeAll(async () => {
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../cloud/src/styles/global.css")].map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
      return build.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const entry = resolve(import.meta.dir, "weather-flat.controller.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(resolve(import.meta.dir, "../../../ui/dist/browser/index.js"))};
window.installController = () => installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the workspace controller.");
  controller = await bundle.outputs[0]!.text();
  // Classic scrollbars that take room in the layout (Chromium hides them by default in headless runs): a column that
  // scrolls sideways or a head that wraps only shows with them (coordinator, 21.11.).
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Plex and the icon font as data URLs, for screenshots only: the measuring tests do not need them. */
const fonts = async () => {
  const from = resolve(import.meta.dir, "../../../ui/src");
  const data = async (path: string) => `data:font/woff2;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
  const plex = await Promise.all(
    [400, 500, 600, 700].map(
      async (weight) =>
        `@font-face{font-family:"IBM Plex Sans";font-weight:${weight};src:url(${await data(Bun.resolveSync(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`, from))}) format("woff2")}`,
    ),
  );
  const iconsCss = Bun.resolveSync("@tabler/icons-webfont/dist/tabler-icons.min.css", from);
  const icons = (await Bun.file(iconsCss).text()).replace(/@font-face\{[^}]*\}/, "");
  const iconFont = await data(resolve(iconsCss, "../fonts/tabler-icons.woff2"));
  return `${plex.join("")}@font-face{font-family:"tabler-icons";src:url(${iconFont}) format("woff2")}${icons}`;
};

const open = async (scenario: Scenario, width: number): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : width < 1024 ? 1024 : 900 },
    hasTouch: false,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const body = renderToString(() => createComponent(WeatherFlatFixture, { scenario }));
  await page.setContent(
    `<!doctype html><html lang="de" class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${shots ? await fonts() : ""}</style><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}#app{display:flex;height:100dvh;container:k2b-app-area/inline-size}</style></head><body class="k2b-ui"><div id="app">${body}</div></body></html>`,
  );
  await page.addScriptTag({ content: controller });
  await page.evaluate(async () => {
    (window as unknown as { installController: () => void }).installController();
    await document.fonts.ready;
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
  });
  return page;
};

const IGNORE =
  ".k2b-app-workspace__resize, .k2b-app-workspace__head-heading, .k2b-app-workspace__head-primary-label, .k2b-sr-only, [data-layout-check='skip']";

for (const scenario of ["few", "many", "unavailable", "missing"] as const)
  for (const width of [390, 768, 1100, 1440])
    test(`${scenario} ${width} px: nothing overlaps, spills, is cut, or draws a double line`, async () => {
      const page = await open(scenario, width);
      try {
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: resolve(shots, `weather-${scenario}-${width}.png`) });
        }
        await settled(page);
        const found = await page.evaluate(layoutProblems, { root: "#app", ignore: IGNORE });
        expect(found.problems).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

test("the long page scrolls inside the main column, topics and week rows are divided by single hairlines", async () => {
  const page = await open("many", 1440);
  try {
    await settled(page);
    const result = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".weather-week [role='listitem']"));
      return {
        scrolls: main.scrollHeight > main.clientHeight,
        // A desktop window without touch would draw a classic scrollbar; the flat main column hides it and draws its
        // overlay thumb instead, so the scrollbar takes no room and the rows reach the column edge (K2).
        gutter: main.offsetWidth - main.clientWidth,
        thumb: main.querySelector(":scope > .k2b-overlay-scrollbar")?.getAttribute("data-overflow") === "true",
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        lines: rows.map((row) => getComputedStyle(row).borderTopWidth),
        // The column draws one hairline above every topic but the first; the left of the two side-by-side columns
        // divides its own topics the same way, and the right column starts with the line between the two (K2).
        topics: Array.from(document.querySelectorAll(".weather-detail > *, .weather-columns > .k2b-divided > *")).map(
          (topic) => getComputedStyle(topic).borderTopWidth,
        ),
        between: getComputedStyle(document.querySelector(".weather-columns > :last-child")!).borderLeftWidth,
      };
    });
    expect(result.scrolls).toBe(true);
    expect(result.gutter).toBe(0);
    expect(result.thumb).toBe(true);
    expect(result.heights).toEqual(Array(7).fill(40));
    expect(result.lines).toEqual(["0px", ...Array(6).fill("1px")]);
    // Article: now, hourly, columns; left column: week, measurements.
    expect(result.topics).toEqual(["0px", "1px", "1px", "0px", "1px"]);
    expect(result.between).toBe("1px");
  } finally {
    await page.context().close();
  }
});

// QA 22.11.: the week's rain and sunshine stood at different places per row and ran into the temperatures beside the
// radar at 768 px. Every row has the same columns: their right edges line up, and a narrow list drops sunshine whole.
for (const width of [768, 1440])
  test(`${width} px: the week's rain and sunshine columns line up over all rows`, async () => {
    const page = await open("many", width);
    try {
      await settled(page);
      const result = await page.evaluate(() => {
        const edges = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => Math.round(element.getBoundingClientRect().right));
        const list = document.querySelector<HTMLElement>(".weather-week [role='list']")!;
        return { list: list.getBoundingClientRect().width, rain: edges(".weather-day__rain"), sun: edges(".weather-day__sun") };
      });
      expect(result.rain).toHaveLength(7);
      expect(new Set(result.rain).size).toBe(1);
      if (result.list < 400) expect(result.sun).toEqual([]);
      else {
        expect(result.sun).toHaveLength(7);
        expect(new Set(result.sun).size).toBe(1);
      }
    } finally {
      await page.context().close();
    }
  });
