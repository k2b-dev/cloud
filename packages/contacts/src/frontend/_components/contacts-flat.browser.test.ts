import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { appHostCss } from "../../../../ui/test/app-host-fixture";
import { browserName, launchBrowser, settled } from "../../../../ui/test/browser";
import { layoutProblems } from "../../../../ui/test/head-overlap";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// Cloud flach (K1, K2, K7, K15, K17): the contacts workspace as the server renders it, with the global and the app
// stylesheet and the shared workspace controller. Nothing overlaps, spills, is cut, draws a double line, or scrolls
// sideways, at 1440 and 390 px, with a short list, a long one that scrolls, an empty book, and a full and a sparse
// contact record. Every person is invented.
const packageCache = resolve(import.meta.dir, "../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "contacts-flat-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ContactsFlatFixture } = await import("./contacts-flat.browser-fixture");
type Props = Parameters<typeof ContactsFlatFixture>[0];

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let css: string;
let controller: string;
// `CONTACTS_FLAT_SHOTS=<dir>` also saves light screenshots for the design review.
const shots = process.env.CONTACTS_FLAT_SHOTS;

beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "../../styles/app.css"));
  const entry = resolve(import.meta.dir, "contacts-flat.controller.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(resolve(import.meta.dir, "../../../../ui/dist/browser/index.js"))};
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
  const from = resolve(import.meta.dir, "../../../../ui/src");
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
    viewport: { width, height: width < 768 ? 844 : width < 1024 ? 1024 : 900 },
    hasTouch: false,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const body = renderToString(() => createComponent(ContactsFlatFixture, props));
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

// Building blocks that reach past their box on purpose: a folded section's toggle is a row from column edge to column
// edge, and a detail action's fill reaches 8 px past the text edge. On a desktop the workspace head without a head
// slot stands collapsed in the grid while the chrome shows the title. Each is the owning block's, not this app's.
const IGNORE =
  ".k2b-app-workspace__resize, .k2b-app-workspace__head-heading, .k2b-app-workspace__head-primary-label, .k2b-sr-only, .sr-only, [data-layout-check='skip'], .k2b-section__header:has(> .k2b-section__toggle), .k2b-detail-panel__action";
const IGNORE_DESKTOP = `${IGNORE}, .k2b-app-workspace__head`;

for (const scenario of ["few", "many", "empty", "record", "sparse"] as const)
  for (const width of [390, 768, 1100, 1440])
    test(`${scenario} ${width} px: nothing overlaps, spills, is cut, or draws a double line`, async () => {
      const page = await open({ scenario }, width);
      try {
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: resolve(shots, `contacts-${scenario}-${width}.png`) });
        }
        await settled(page);
        const found = await page.evaluate(layoutProblems, { root: "#app", ignore: width >= 1024 ? IGNORE_DESKTOP : IGNORE });
        expect(found.problems).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

test("list rows are 52 px, two lines even with tags, with one hairline between them, the record's topics are divided too", async () => {
  const page = await open({ scenario: "record" }, 1920);
  try {
    await settled(page);
    const result = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".contacts-list > li"));
      const links = Array.from(document.querySelectorAll<HTMLElement>(".contacts-list__row"));
      const topics = Array.from(document.querySelectorAll<HTMLElement>(".contacts-record__topics > *"));
      const facts = document.querySelector<HTMLElement>(".contacts-record__facts")!;
      const record = document.querySelector<HTMLElement>(".contacts-record")!.getBoundingClientRect();
      return {
        heights: [...new Set(links.map((row) => Math.round(row.getBoundingClientRect().height)))],
        lines: rows.map((row) => getComputedStyle(row).borderTopWidth),
        radius: getComputedStyle(document.querySelector(".contacts-list__row")!).borderRadius,
        topics: topics.map((topic) => getComputedStyle(topic).borderTopWidth),
        // From 50rem the facts are a quiet column on the right, at most 400 px, divided by the record's one line.
        factsBeside: Math.round(facts.getBoundingClientRect().right) === Math.round(record.right),
        factsWidth: facts.getBoundingClientRect().width,
        factsLine: getComputedStyle(facts).borderLeftWidth,
      };
    });
    expect(result.heights).toEqual([52]);
    expect(result.lines).toEqual(["0px", ...Array(result.lines.length - 1).fill("1px")]);
    expect(result.radius).toBe("0px");
    expect(result.topics).toEqual(["0px", ...Array(result.topics.length - 1).fill("1px")]);
    expect(result.factsBeside).toBe(true);
    expect(result.factsWidth).toBeLessThanOrEqual(400);
    expect(result.factsLine).toBe("1px");
  } finally {
    await page.context().close();
  }
});

test("at 1100 px the record stands open beside the list, and classic scrollbars take their room", async () => {
  const page = await open({ scenario: "record" }, 1100);
  try {
    await settled(page);
    const result = await page.evaluate(() => {
      const reader = document.querySelector<HTMLElement>(".contacts-reader")!.getBoundingClientRect();
      const list = document.querySelector<HTMLElement>(".contacts-list")!.getBoundingClientRect();
      // The long list scrolls; its scroller shows a classic scrollbar that takes room.
      const scrollers = Array.from(document.querySelectorAll<HTMLElement>("#app *")).filter(
        (element) => element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY),
      );
      return {
        beside: reader.width > 0 && list.width > 0 && reader.left >= list.right,
        gutter: Math.max(0, ...scrollers.map((element) => element.offsetWidth - element.clientWidth)),
      };
    });
    expect(result.beside).toBe(true);
    // Chromium shows classic scrollbars only without --hide-scrollbars; a stable gutter then takes room.
    if (browserName === "chromium") expect(result.gutter).toBeGreaterThan(0);
  } finally {
    await page.context().close();
  }
});
