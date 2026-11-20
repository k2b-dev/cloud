import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { type BlockScene, fixtureImage, imageStateScenes, blockScenes as scenes } from "./blocks.fixtures";
import { validateBlocks } from "./validate";

// Islands, flat options and the six-column rows depend on the real layout engine, at desktop and phone widths.
const root = mkdtempSync(resolve(tmpdir(), "cloud-blocks-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { BlockTree } = await import("./BlockTree");
const { LocaleProvider } = await import("@k2b/ui");

/** The server's render, the first frame a person sees: tables still wait for their code. */
const render = (scene: BlockScene) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(BlockTree, {
          blocks: scene.blocks,
          host: "result",
          locale: "de",
          timeZone: "Europe/Berlin",
          choice: scene.choice,
        });
      },
    }),
  );

const ui = resolve(import.meta.dir, "../../../ui");
/** The same scenes drawn in the browser, where a table's code arrives after the first frame. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "BlockTree.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-block-tree-test",
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
  if (!build.success) throw new AggregateError(build.logs, "BlockTree harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  const [bundle, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  css = await styles.outputs[0]!.text();
  harness = bundle;
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("The Tabler preset references no WOFF2 file.");
  icons = { css: source.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const MAIN = `<main style="box-sizing:border-box;padding:24px 16px;max-width:calc(764px + 32px);margin:0 auto">`;

const open = async (
  scene: BlockScene,
  width: number,
  drawn: "server" | "browser" = "browser",
  host: "result" | "preview" = "result",
): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width, height: 1000 } });
  await tab.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/tabler.woff2")
      return route.fulfill({ body: Buffer.from(await Bun.file(icons.font).arrayBuffer()), contentType: "font/woff2" });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    // A picture still being drawn never answers while the test looks; a refused one answers like a missing one.
    if (url.pathname.endsWith("/waiting.svg")) return;
    if (url.pathname.endsWith("/missing.svg"))
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"code":"not_found"}' });
    if (url.pathname.endsWith(".svg")) return route.fulfill({ body: fixtureImage(url.pathname), contentType: "image/svg+xml" });
    return route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${icons.css}</style></head>` +
        `<body class="k2b-ui">${MAIN}${drawn === "server" ? render(scene) : ""}</main>` +
        `${drawn === "browser" ? '<script type="module" src="/harness.js"></script>' : ""}</body></html>`,
    });
  });
  await tab.goto(`http://blocks.test/?scene=${scene.name}&host=${host}`);
  if (drawn === "browser") {
    await tab.locator(".cloud-blocks").first().waitFor();
    // Tables and key figures are drawn once their code has arrived and nothing waits any more.
    await tab.waitForFunction(
      () =>
        !document.querySelector(":is(.cloud-blocks__cell[data-kind='Table'], .cloud-blocks__cell[data-kind='Stats']) [aria-busy='true']"),
    );
  }
  await settled(tab);
  return tab;
};

const tableHeights = (tab: Page) =>
  tab.evaluate(() =>
    Array.from(document.querySelectorAll(".cloud-blocks__cell[data-kind='Table'], .cloud-blocks__cell[data-kind='Stats']")).map(
      (cell) => cell.getBoundingClientRect().height,
    ),
  );

describe("BlockTree", () => {
  test("every fixture is a valid bound result view of its app", () => {
    for (const scene of scenes)
      expect(() => validateBlocks(scene.blocks, "result", { appId: scene.app.slice(1), appPrefixes: [scene.app] })).not.toThrow();
  });

  for (const width of [1440, 390])
    for (const scene of scenes)
      test(`${scene.name} at ${width} px: no hull, islands only for media cards and frames, nothing overflows`, async () => {
        const tab = await open(scene, width);
        try {
          const facts = await tab.evaluate(() => {
            const shadow = (node: Element | null) => (node ? getComputedStyle(node).boxShadow : "none");
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              hull: getComputedStyle(document.querySelector(".cloud-blocks")!).backgroundColor,
              mediaCards: document.querySelectorAll(".cloud-blocks__card[data-island]").length,
              textCards: document.querySelectorAll(".cloud-blocks__card:not([data-island])").length,
              optionShadows: Array.from(document.querySelectorAll(".cloud-blocks__choice [role='radio'], .cloud-blocks__choice label")).map(
                shadow,
              ),
              cells: Array.from(document.querySelectorAll(".cloud-blocks__cell")).map((cell) =>
                Math.round(cell.getBoundingClientRect().width),
              ),
              selected: Array.from(document.querySelectorAll(".cloud-blocks__card[data-selected] .cloud-blocks__card-title")).map(
                (node) => node.textContent,
              ),
              brokenImages: Array.from(document.images).filter((image) => image.complete && image.naturalWidth === 0).length,
            };
          });
          expect(facts.overflow).toBe(0);
          expect(facts.hull).toBe("rgba(0, 0, 0, 0)");
          expect(facts.textCards).toBe(0);
          expect(facts.brokenImages).toBe(0);
          // Options of a choice are controls: flat, never raised.
          // A control's edge may be drawn as an inset ring; a blurred drop shadow would lift it.
          // Main #3681 reserves a transparent 3 px focus ring. Its spread is not blur or a raised island.
          for (const value of facts.optionShadows)
            expect(
              value
                .split(/,(?![^(]*\))/)
                .filter((layer) => layer.trim() !== "rgba(0, 0, 0, 0) 0px 0px 0px 3px")
                .filter((layer) => !layer.includes("inset") && /-?\d+px -?\d+px [1-9]/.test(layer)),
            ).toEqual([]);
          if (scene.name === "03-reise-gewaehlt") expect(facts.selected).toEqual(["Trattoria Lucia"]);
          if (scene.name === "07-tabelle-grids") {
            // A row with a target leads there: one Open link per row, in the app, in the same tab.
            const links = await tab
              .getByRole("link", { name: "Öffnen" })
              .evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("href"), node.getAttribute("target")]));
            expect(links).toEqual([
              ["/grids/lager-nord/r/12", null],
              ["/grids/lager-nord/r/31", null],
              ["/grids/lager-nord/r/7", null],
            ]);
          }
          if (scene.name === "04-finanzen-uebersicht") {
            // Key figures span the row; chart and table share it on a wide column and stack on a phone.
            const [, chart, table] = facts.cells;
            if (width === 1440) expect(Math.abs(chart! - table!)).toBeLessThanOrEqual(1);
            else expect(chart).toBe(facts.cells[0]);
          }
          const shots = process.env.CAPBLOCKS_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await tab.screenshot({ path: resolve(shots, `${scene.name}-light-${width}.png`), fullPage: true });
          }
        } finally {
          await tab.close();
        }
      });

  for (const width of [1440, 390])
    test(`at ${width} px a search preview's picture keeps one 4:3 place while it loads, once drawn, and when refused`, async () => {
      const shots = process.env.CAPBLOCKS_SHOTS;
      const states = [];
      for (const scene of imageStateScenes) {
        const tab = await open(scene, width, "browser", "preview");
        try {
          if (scene.name === "15-suche-datei")
            await tab.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
          if (scene.name === "15-suche-datei-fehlt") await tab.locator(".cloud-blocks__image-missing").waitFor();
          await settled(tab);
          states.push(
            await tab.evaluate(() => {
              const box = (selector: string) => {
                const rect = document.querySelector(selector)!.getBoundingClientRect();
                return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
              };
              const missing = document.querySelector(".cloud-blocks__image-missing");
              return {
                picture: box(".cloud-blocks__image"),
                details: box(".cloud-blocks__cell[data-kind='Detail']"),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                images: document.images.length,
                stand_in: missing ? { role: missing.getAttribute("role"), label: missing.getAttribute("aria-label") } : null,
                stand_in_box: missing ? box(".cloud-blocks__image-missing") : null,
              };
            }),
          );
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await tab.screenshot({ path: resolve(shots, `${scene.name}-light-${width}.png`), fullPage: true });
          }
        } finally {
          await tab.close();
        }
      }
      const [drawn, loading, refused] = states;
      expect(drawn!.overflow).toBe(0);
      expect(drawn!.stand_in).toBeNull();
      expect(drawn!.picture.width).toBeGreaterThan(0);
      expect(Math.abs(drawn!.picture.width / drawn!.picture.height - 4 / 3)).toBeLessThan(0.01);
      // Loading shows the muted place itself; a refused picture leaves a labelled stand-in of the same size.
      expect(loading!.images).toBe(1);
      expect(refused!.images).toBe(0);
      expect(refused!.stand_in).toEqual({ role: "img", label: "Vase_Albers_Boden.jpg" });
      expect(refused!.stand_in_box).toEqual(refused!.picture);
      for (const state of [loading!, refused!]) {
        expect(state.overflow).toBe(0);
        expect(state.picture).toEqual(drawn!.picture);
        expect(state.details).toEqual(drawn!.details);
      }
    });

  for (const width of [1440, 390])
    test(`at ${width} px tables and key figures keep the room of their first frame when their code arrives`, async () => {
      for (const scene of scenes.filter((entry) => entry.blocks.some((block) => block.kind === "Table" || block.kind === "Stats"))) {
        const first = await open(scene, width, "server");
        const drawn = await open(scene, width);
        try {
          const waiting = await first.evaluate(
            () =>
              document.querySelectorAll(
                ":is(.cloud-blocks__cell[data-kind='Table'], .cloud-blocks__cell[data-kind='Stats']) [aria-busy='true']",
              ).length,
          );
          expect(waiting).toBeGreaterThan(0);
          const before = await tableHeights(first);
          const after = await tableHeights(drawn);
          expect(after.length).toBe(before.length);
          for (const [index, height] of after.entries()) expect(Math.abs(height - before[index]!)).toBeLessThanOrEqual(0.5);
        } finally {
          await first.close();
          await drawn.close();
        }
      }
    });
});
