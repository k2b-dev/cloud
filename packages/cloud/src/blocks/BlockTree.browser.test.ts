import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { artFollowUp, artView, financeView, fixtureImage, gridsView, travelView } from "./blocks.fixtures";
import type { Block } from "./schema";
import { validateBlocks } from "./validate";

// Islands, flat options and the six-column rows depend on the real layout engine, at desktop and phone widths.
const root = mkdtempSync(resolve(tmpdir(), "cloud-blocks-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { BlockTree } = await import("./BlockTree");
const { LocaleProvider } = await import("@k2b/ui");

type Scene = { name: string; app: string; blocks: Block[]; choice?: Parameters<typeof BlockTree>[0]["choice"] };
const scenes: Scene[] = [
  { name: "01-kunst-offen", app: "/kunst", blocks: artView, choice: { state: "open" } },
  { name: "02-kunst-gewaehlt", app: "/kunst", blocks: artFollowUp },
  { name: "03-reise-gewaehlt", app: "/reisen", blocks: travelView, choice: { state: "answered", chosen: ["lucia"], answeredAt: "14:41" } },
  { name: "04-finanzen-uebersicht", app: "/finanzen", blocks: financeView },
  { name: "07-tabelle-grids", app: "/grids", blocks: gridsView },
];

const render = (scene: Scene) =>
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

let browser: Browser;
let css: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
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

const open = async (scene: Scene, width: number): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width, height: 1000 } });
  await tab.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/tabler.woff2")
      return route.fulfill({ body: Buffer.from(await Bun.file(icons.font).arrayBuffer()), contentType: "font/woff2" });
    if (url.pathname.endsWith(".svg")) return route.fulfill({ body: fixtureImage(url.pathname), contentType: "image/svg+xml" });
    return route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${icons.css}</style></head>` +
        `<body class="k2b-ui"><main style="box-sizing:border-box;padding:24px 16px;max-width:calc(764px + 32px);margin:0 auto">${render(scene)}</main></body></html>`,
    });
  });
  await tab.goto("http://blocks.test/");
  await settled(tab);
  return tab;
};

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
          // A control's 2 px edge may be drawn as an inset ring; a blurred drop shadow would lift it.
          for (const value of facts.optionShadows)
            expect(value.split(/,(?![^(]*\))/).filter((layer) => !layer.includes("inset") && /-?\d+px -?\d+px [1-9]/.test(layer))).toEqual(
              [],
            );
          if (scene.name === "03-reise-gewaehlt") expect(facts.selected).toEqual(["Trattoria Lucia"]);
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
});
