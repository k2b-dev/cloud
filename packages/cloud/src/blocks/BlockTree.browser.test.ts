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
import {
  type BlockScene,
  FIT_FIXTURE_COLOUR,
  fixtureImage,
  imageEdgeScenes,
  imageFitScenes,
  imageLayoutScenes,
  imageStateScenes,
  blockScenes as scenes,
} from "./blocks.fixtures";
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

/** Every picture address the harness asked for, with its query, in order. */
const imageRequests: string[] = [];

const MAIN = `<main style="box-sizing:border-box;padding:24px 16px;max-width:calc(764px + 32px);margin:0 auto">`;

const open = async (
  scene: BlockScene,
  width: number,
  drawn: "server" | "browser" = "browser",
  host: "result" | "preview" | "review" = "result",
  clock = false,
): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width, height: 1000 } });
  // A fake clock holds frames too, so the caller settles the page once it lets time run again.
  if (clock) await tab.clock.install();
  await tab.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(".svg")) imageRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/tabler.woff2")
      return route.fulfill({ body: Buffer.from(await Bun.file(icons.font).arrayBuffer()), contentType: "font/woff2" });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    // A picture still being drawn never answers while the test looks; a refused one answers like a missing one.
    if (url.pathname.endsWith("/waiting.svg")) return;
    if (url.pathname.endsWith("/missing.svg"))
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"code":"not_found"}' });
    // A picture refused at first whose later tries are still under way.
    if (url.pathname.endsWith("/later.svg"))
      return url.search
        ? undefined
        : route.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"code":"not_found"}' });
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
  if (!clock) await settled(tab);
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
      let waitBox: { x: number; y: number; width: number; height: number } | null = null;
      let asked: string[] = [];
      for (const scene of imageStateScenes) {
        const refusedScene = scene.name === "15-suche-datei-fehlt";
        imageRequests.length = 0;
        const tab = await open(scene, width, "browser", "preview", refusedScene);
        try {
          if (scene.name === "15-suche-datei")
            await tab.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
          if (refusedScene) {
            // An <img> cannot tell a picture still being drawn (202) from a missing one: it waits on the muted place and
            // asks twice more, 2 s apart, before the stand-in shows.
            for (const attempt of [1, 2]) {
              await tab.locator(".cloud-blocks__image-wait").waitFor();
              if (attempt === 1) waitBox = await tab.locator(".cloud-blocks__image-wait").boundingBox();
              await tab.clock.runFor(2_000);
            }
            await tab.locator(".cloud-blocks__image-missing").waitFor();
            await tab.clock.resume();
            asked = [...imageRequests];
          }
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
      // The first frame asked once; each later try asked under a fresh address, then nothing more.
      expect(asked).toEqual(["/kunst/images/missing.svg", "/kunst/images/missing.svg?retry=1", "/kunst/images/missing.svg?retry=2"]);
      expect(waitBox && { top: waitBox.y, left: waitBox.x, width: waitBox.width, height: waitBox.height }).toEqual(drawn!.picture);
      for (const state of [loading!, refused!]) {
        expect(state.overflow).toBe(0);
        expect(state.picture).toEqual(drawn!.picture);
        expect(state.details).toEqual(drawn!.details);
      }
    });

  for (const width of [1440, 390])
    test(`at ${width} px a picture is at most 24 rem wide in a result, and a 4:3 thumbnail beside its details in an approval`, async () => {
      for (const scene of imageLayoutScenes) {
        expect(() => validateBlocks(scene.blocks, scene.host, { appId: scene.app.slice(1), appPrefixes: [scene.app] })).not.toThrow();
        const tab = await open(scene, width, "browser", scene.host);
        try {
          await tab.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
          await settled(tab);
          const facts = await tab.evaluate(() => {
            const box = (node: Element) => {
              const rect = node.getBoundingClientRect();
              return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
            };
            const figure = document.querySelector(".cloud-blocks__image")!;
            const cell = figure.closest(".cloud-blocks__cell")!;
            const detail = document.querySelector(".cloud-blocks__cell[data-media-row] > :not(.cloud-blocks__image)");
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              cell: box(cell),
              mediaRow: cell.hasAttribute("data-media-row"),
              figure: box(figure),
              picture: box(figure.querySelector("img")!),
              detail: detail ? box(detail) : null,
              rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
            };
          });
          expect(facts.overflow).toBe(0);
          if (scene.host === "result") {
            // Its own place, at most 24 rem wide on a wide column and the whole column on a phone, in its own ratio.
            expect(facts.mediaRow).toBe(false);
            expect(facts.figure.width).toBe(Math.min(24 * facts.rem, facts.cell.width));
            expect(facts.picture).toEqual(facts.figure);
            expect(Math.abs(facts.figure.width / facts.figure.height - 16 / 9)).toBeLessThan(0.01);
          } else {
            // The thumbnail of what changes: 6 rem, 4:3, its details to its right.
            expect(facts.mediaRow).toBe(true);
            expect(facts.figure.width).toBe(6 * facts.rem);
            expect(facts.picture.width).toBe(facts.figure.width);
            expect(Math.abs(facts.picture.width / facts.picture.height - 4 / 3)).toBeLessThan(0.01);
            expect(facts.detail!.left).toBeGreaterThan(facts.figure.left + facts.figure.width);
          }
          const shots = process.env.CAPBLOCKS_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await tab.screenshot({ path: resolve(shots, `${scene.name}-light-${width}.png`), fullPage: true });
          }
        } finally {
          await tab.close();
        }
      }
    });

  for (const width of [1440, 390])
    for (const host of ["preview", "review"] as const)
      test(`at ${width} px a portrait or landscape picture is fitted whole into the same place in a ${host === "preview" ? "search preview" : "approval"}`, async () => {
        /** The picture's place, its details, and where the picture's own colour runs along its middle row and column. */
        const measure = async (tab: Page) => {
          const place = tab.locator(".cloud-blocks__image img");
          const shot = (await place.screenshot()).toString("base64");
          return tab.evaluate(
            async ({ shot, colour }) => {
              const box = (node: Element) => {
                const rect = node.getBoundingClientRect();
                return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
              };
              const image = new Image();
              image.src = `data:image/png;base64,${shot}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              const picture = (x: number, y: number) => {
                const [r, g, b] = context.getImageData(x, y, 1, 1).data;
                return Math.abs(r! - colour[0]) + Math.abs(g! - colour[1]) + Math.abs(b! - colour[2]) < 24;
              };
              const run = (length: number, at: (index: number) => boolean) => {
                const hits = Array.from({ length }, (_, index) => index).filter(at);
                return hits.length ? { from: hits[0]!, to: hits.at(-1)! + 1 } : null;
              };
              const [width, height] = [canvas.width, canvas.height];
              const img = document.querySelector(".cloud-blocks__image img")!;
              return {
                place: box(img),
                // In an approval the details share the picture's row; in a search preview they have a cell of their own.
                details: box(
                  document.querySelector(
                    ":is(.cloud-blocks__cell[data-kind='Detail'], .cloud-blocks__cell[data-media-row] > :not(.cloud-blocks__image))",
                  )!,
                ),
                fit: getComputedStyle(img).objectFit,
                ground: getComputedStyle(img).backgroundColor,
                shot: { width, height },
                row: run(width, (x) => picture(x, Math.floor(height / 2))),
                column: run(height, (y) => picture(Math.floor(width / 2), y)),
              };
            },
            { shot, colour: FIT_FIXTURE_COLOUR },
          );
        };
        {
          const facts: Partial<Record<(typeof imageFitScenes)[number]["shape"], Awaited<ReturnType<typeof measure>>>> = {};
          for (const scene of imageFitScenes.filter((entry) => entry.host === host)) {
            expect(() => validateBlocks(scene.blocks, host, { appId: scene.app.slice(1), appPrefixes: [scene.app] })).not.toThrow();
            const tab = await open(scene, width, "browser", host);
            try {
              await tab.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
              await settled(tab);
              facts[scene.shape] = await measure(tab);
              const shots = process.env.CAPBLOCKS_SHOTS;
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await tab.screenshot({ path: resolve(shots, `${scene.name}-light-${width}.png`), fullPage: true });
              }
            } finally {
              await tab.close();
            }
          }
          const { m_12: square, hoch, quer } = facts as Required<typeof facts>;
          // One 4:3 place for every shape: the picture never makes it taller, and the details beside or below never move.
          expect(Math.abs(square.place.width / square.place.height - 4 / 3)).toBeLessThan(0.01);
          for (const shape of [hoch, quer]) {
            expect(shape.place).toEqual(square.place);
            expect(shape.details).toEqual(square.details);
            expect(shape.fit).toBe("contain");
            expect(shape.ground).toBe(square.ground);
          }
          const { width: w, height: h } = hoch.shot;
          // An edge pixel may be blended with the ground (WebKit), so the picture's own edges count to within 1 px.
          // Portrait: the whole height, centred, with the muted ground on both sides.
          expect(hoch.column!.from).toBeLessThanOrEqual(1);
          expect(hoch.column!.to).toBeGreaterThanOrEqual(h - 1);
          expect(Math.abs(hoch.row!.to - hoch.row!.from - (h * 90) / 160)).toBeLessThanOrEqual(2);
          expect(Math.abs(hoch.row!.from - (w - hoch.row!.to))).toBeLessThanOrEqual(2);
          expect(hoch.row!.from).toBeGreaterThan(w / 8);
          // Landscape: the whole width, centred, with the muted ground above and below.
          expect(quer.row!.from).toBeLessThanOrEqual(1);
          expect(quer.row!.to).toBeGreaterThanOrEqual(w - 1);
          expect(Math.abs(quer.column!.to - quer.column!.from - (w * 90) / 160)).toBeLessThanOrEqual(2);
          expect(Math.abs(quer.column!.from - (h - quer.column!.to))).toBeLessThanOrEqual(2);
          expect(quer.column!.from).toBeGreaterThan(h / 16);
        }
      });

  for (const width of [1440, 390])
    test(`at ${width} px a caption below a picture with a ratio never makes the picture smaller`, async () => {
      const scene = imageEdgeScenes.find((entry) => entry.name === "19-bild-unterschrift")!;
      expect(() => validateBlocks(scene.blocks, "result", { appId: "kunst", appPrefixes: [scene.app] })).not.toThrow();
      const tab = await open(scene, width);
      try {
        await tab.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
        await settled(tab);
        const facts = await tab.evaluate(() => {
          const box = (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          };
          return {
            figure: box(".cloud-blocks__image"),
            picture: box(".cloud-blocks__image img"),
            caption: box(".cloud-blocks__image figcaption"),
            cell: box(".cloud-blocks__cell"),
            rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          };
        });
        // The picture keeps the full width and its own 16:9; the caption adds its line below instead.
        expect(facts.picture.width).toBe(Math.min(24 * facts.rem, facts.cell.width));
        expect(facts.picture.width).toBe(facts.figure.width);
        expect(Math.abs(facts.picture.width / facts.picture.height - 16 / 9)).toBeLessThan(0.01);
        expect(facts.caption.top).toBeGreaterThanOrEqual(facts.picture.top + facts.picture.height);
        expect(facts.figure.height).toBeGreaterThan(facts.picture.height);
      } finally {
        await tab.close();
      }
    });

  test("a picture without a ratio keeps one small place while it waits for a later try and while that try loads", async () => {
    const scene = imageEdgeScenes.find((entry) => entry.name === "20-bild-ohne-format-wartet")!;
    imageRequests.length = 0;
    const tab = await open(scene, 1440, "browser", "result", true);
    try {
      const height = (selector: string) => tab.locator(selector).evaluate((node) => node.getBoundingClientRect().height);
      const rem = await tab.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
      const heights: number[] = [];
      for (const attempt of [1, 2]) {
        await tab.locator(".cloud-blocks__image-wait").waitFor();
        heights.push(await height(".cloud-blocks__image-wait"));
        const asked = tab.waitForRequest((request) => request.url().endsWith(`later.svg?retry=${attempt}`));
        await tab.clock.runFor(2_000);
        // The later try is under way, asked and not answered: its picture holds the same place as the wait before it.
        await tab.locator(`.cloud-blocks__image img[data-retry][src$="retry=${attempt}"]`).waitFor();
        await asked;
        heights.push(await height(".cloud-blocks__image img"));
        if (attempt === 1) await tab.evaluate(() => document.querySelector(".cloud-blocks__image img")!.dispatchEvent(new Event("error")));
      }
      await tab.clock.resume();
      expect(heights).toEqual([3 * rem, 3 * rem, 3 * rem, 3 * rem]);
      expect(imageRequests).toEqual(["/kunst/images/later.svg", "/kunst/images/later.svg?retry=1", "/kunst/images/later.svg?retry=2"]);
    } finally {
      await tab.close();
    }
  });

  test("before hydration only a requested picture that does not decode counts as failed", async () => {
    const tab = await open(imageEdgeScenes[0]!, 1440);
    try {
      const failed = await tab.evaluate(async () => {
        const picture = (src: string, style = "") => {
          const image = document.createElement("img");
          image.loading = "lazy";
          image.src = src;
          image.setAttribute("style", `display:block;width:96px;height:72px;${style}`);
          document.body.append(image);
          return image;
        };
        const refused = picture("/kunst/images/missing.svg");
        const viewBoxOnly = picture("/kunst/images/hoch.svg");
        // Far below the viewport: a lazy picture there has not been asked for yet.
        const below = picture("/kunst/images/missing.svg?below", "margin-top:40000px");
        await Promise.all(
          [refused, viewBoxOnly].map(
            (image) =>
              new Promise<void>((done) => {
                if (image.complete) return done();
                image.addEventListener("load", () => done(), { once: true });
                image.addEventListener("error", () => done(), { once: true });
              }),
          ),
        );
        return Promise.all([refused, viewBoxOnly, below].map((image) => window.failedBeforeHydration(image)));
      });
      expect(failed).toEqual([true, false, false]);
    } finally {
      await tab.close();
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
