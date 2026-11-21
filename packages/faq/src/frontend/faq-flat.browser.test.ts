import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// Cloud flach (K1, K2, K15): the public FAQ and its admin list as the server renders them, with the global and the app
// stylesheet. Nothing overlaps, spills, is cut, draws a double line, or scrolls sideways, at 1440 and 390 px, with a
// short list and with a long one that scrolls. Every question is invented.
const packageCache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "faq-flat-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: FaqFlatFixture } = await import("./faq-flat.browser-fixture");
type Props = Parameters<typeof FaqFlatFixture>[0];

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let css: string;
// `FAQ_FLAT_SHOTS=<dir>` also saves light screenshots for the design review.
const shots = process.env.FAQ_FLAT_SHOTS;

beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "../styles/app.css"));
  browser = await launchBrowser();
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

const open = async (props: Props, width: number): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 900 },
    hasTouch: false,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const body = renderToString(() => createComponent(FaqFlatFixture, props));
  await page.setContent(
    `<!doctype html><html lang="de" class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${shots ? await fonts() : ""}</style><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}#app{display:flex;height:100dvh}</style></head><body class="k2b-ui"><div id="app">${body}</div></body></html>`,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
  });
  return page;
};

for (const view of ["public", "admin"] as const)
  for (const scenario of ["few", "many", "empty"] as const)
    for (const width of [1440, 390])
      test(`${view} ${scenario} ${width} px: nothing overlaps, spills, is cut, or draws a double line`, async () => {
        const page = await open({ view, scenario }, width);
        try {
          // An open answer is part of the layout too.
          if (view === "public" && scenario !== "empty") await page.locator(".faq-entry__question").first().click();
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: resolve(shots, `faq-${view}-${scenario}-${width}.png`) });
          }
          await settled(page);
          const found = await page.evaluate(layoutProblems, { root: "#app" });
          expect(found.problems).toEqual([]);
        } finally {
          await page.context().close();
        }
      });

test("every question is a row of at least 40 px with one hairline between rows and none around the list", async () => {
  const page = await open({ view: "public", scenario: "many" }, 1440);
  try {
    await settled(page);
    const result = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".faq-list")!;
      const entries = Array.from(list.children);
      const style = getComputedStyle(list);
      return {
        heights: Array.from(list.querySelectorAll(".faq-entry__question")).map((row) => Math.round(row.getBoundingClientRect().height)),
        lines: entries.map((entry) => getComputedStyle(entry).borderTopWidth),
        frame: [style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRadius, style.boxShadow],
      };
    });
    expect(result.heights.every((height: number) => height >= 40)).toBe(true);
    expect(result.lines).toEqual(["0px", ...Array(11).fill("1px")]);
    expect(result.frame).toEqual(["0px", "0px", "0px", "0px", "none"]);
  } finally {
    await page.context().close();
  }
});
