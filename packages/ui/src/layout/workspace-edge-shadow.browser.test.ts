import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { clientFixture, type FixtureOptions, workspaceCss, workspaceFrames } from "../../test/workspace-host-fixture";

// A column edge has one shadow. Hover, keyboard focus, and a drag on its
// resize handle only darken it: the painted box keeps its top, height, and
// boundary side in every state, so no second strip appears beside it.
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-edge-shadow-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const script = await clientFixture();
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(60_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const load = async (options: FixtureOptions) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" style="margin:0">
        <button id="park" style="position:fixed;left:0;bottom:0">Away</button>
        <div id="app" style="height:100vh;margin-inline:64px"></div>
      </body></html>`);
    await page.evaluate((options) => {
      document.body.dataset.options = JSON.stringify(options);
    }, options);
    await page.addScriptTag({ content: script });
    await workspaceFrames(page);
    // Only the columns' paint stays, so pixels show the edge shadows alone;
    // the handles stay hoverable and focusable, and their grip is hidden.
    await page.addStyleTag({
      content: `.k2b-app-workspace * { visibility: hidden }
        :is(.k2b-app-workspace__content, .k2b-app-workspace__main, [data-workspace-main-region], .k2b-app-workspace__resize) { visibility: visible }
        [data-workspace-main-region] > *, .k2b-app-workspace__main > :not([data-workspace-main-region], .k2b-app-workspace__resize),
        .k2b-app-workspace__resize > span { visibility: hidden }`,
    });
    await settled(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};

type Edge = { index: number; name: string; boundary: number; handle: { x: number; y: number } };

/** Each column handle and the boundary it resizes: the left edge of the column after it. */
const edges = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-app-workspace-resize]")]
      .map((handle, index) => ({ handle, index }))
      .filter(({ handle }) => handle.getClientRects().length > 0 && handle.dataset.appWorkspaceResize !== "drawer")
      .map(({ handle, index }) => {
        const kind = handle.dataset.appWorkspaceResize!;
        const after =
          kind === "sidebar"
            ? handle.closest(".k2b-app-workspace")!.querySelector(".k2b-app-workspace__content")!
            : kind === "detail"
              ? document.getElementById(handle.getAttribute("aria-controls")!)!
              : handle.nextElementSibling!;
        const box = handle.getBoundingClientRect();
        return {
          index,
          name: `${kind} ${handle.getAttribute("aria-controls")}`,
          boundary: Math.round(after.getBoundingClientRect().left),
          handle: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        };
      }),
  ) as Promise<Edge[]>;

const reach = 40;

/** The window around a boundary, as luminance rows. */
const band = async (page: Page, edge: Edge) => {
  const png = await page.screenshot({ clip: { x: edge.boundary - reach, y: 0, width: reach * 2, height: 900 } });
  return page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      return Array.from(
        { length: image.width * image.height },
        (_, pixel) => (data[pixel * 4]! + data[pixel * 4 + 1]! + data[pixel * 4 + 2]!) / 3,
      );
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
};

/** The box of every pixel that `after` paints darker than `before`, in page coordinates. */
const darkened = (edge: Edge, before: number[], after: number[]) => {
  const width = reach * 2;
  let box: { left: number; right: number; top: number; bottom: number } | null = null;
  for (let pixel = 0; pixel < before.length; pixel++) {
    if (before[pixel]! - after[pixel]! <= 0.5) continue;
    const x = edge.boundary - reach + (pixel % width);
    const y = Math.floor(pixel / width);
    box = box
      ? { left: Math.min(box.left, x), right: Math.max(box.right, x), top: Math.min(box.top, y), bottom: Math.max(box.bottom, y) }
      : { left: x, right: x, top: y, bottom: y };
  }
  if (!box) throw new Error(`${edge.name}: no shadow painted`);
  return { ...box, height: box.bottom - box.top + 1 };
};

const away = async (page: Page) => {
  await page.mouse.move(1, 1);
  await page.locator("#park").focus();
  await settled(page);
};

const states: { name: string; enter: (page: Page, edge: Edge) => Promise<void>; leave: (page: Page) => Promise<void> }[] = [
  {
    name: "hover",
    enter: (page, edge) => page.mouse.move(edge.handle.x, edge.handle.y),
    leave: away,
  },
  {
    name: "keyboard focus",
    enter: async (page, edge) => {
      // Enter keyboard modality before focusing; the pointer stays away.
      await page.keyboard.press("Tab");
      await page.locator("[data-app-workspace-resize]").nth(edge.index).focus();
    },
    leave: away,
  },
  {
    name: "drag",
    enter: async (page, edge) => {
      await page.mouse.move(edge.handle.x, edge.handle.y);
      await page.mouse.down();
    },
    leave: async (page) => {
      await page.mouse.up();
      await away(page);
    },
  },
];

for (const [label, options] of [
  ["sidebar, list pane, and Detail", {}],
  ["sidebar and levels", { scenario: "levels" }],
] as [string, FixtureOptions][])
  test(`${label}: every edge keeps one shadow box through hover, focus, and drag`, async () => {
    const page = await load(options);
    try {
      await away(page);
      const shown = await edges(page);
      expect(shown.map((edge) => edge.name.split(" ")[0])).toEqual(
        label.includes("Detail") ? ["sidebar", "pane", "detail"] : ["sidebar", "pane", "pane"],
      );
      // Every edge and state in one report, so one run names every mismatch.
      const found: unknown[] = [];
      const wanted: unknown[] = [];
      for (const edge of shown) {
        const suppress = await page.addStyleTag({
          content: `.k2b-app-workspace__content::before, .k2b-app-workspace__content::after, [data-workspace-main-region]::before,
            .k2b-app-workspace__resize::after { content: none !important }`,
        });
        await settled(page);
        const plain = await band(page, edge);
        await suppress.evaluate((element) => element.parentNode?.removeChild(element));
        await settled(page);
        const restPixels = await band(page, edge);
        const rest = darkened(edge, plain, restPixels);
        // At rest the shade lies on the column before the boundary and ends at it.
        found.push({ edge: edge.name, state: "rest", end: rest.right - edge.boundary, within: rest.left >= edge.boundary - 24 });
        wanted.push({ edge: edge.name, state: "rest", end: -1, within: true });
        for (const state of states) {
          await state.enter(page, edge);
          await settled(page);
          // What the state adds to the resting paint: the same box, on the same side of the boundary.
          const added = darkened(edge, restPixels, await band(page, edge));
          await state.leave(page);
          found.push({
            edge: edge.name,
            state: state.name,
            top: Math.abs(added.top - rest.top) <= 0.5 ? 0 : added.top - rest.top,
            height: Math.abs(added.height - rest.height) <= 0.5 ? 0 : added.height - rest.height,
            end: added.right - rest.right,
            within: added.left >= edge.boundary - 24,
          });
          wanted.push({ edge: edge.name, state: state.name, top: 0, height: 0, end: 0, within: true });
        }
      }
      expect(found).toEqual(wanted);
    } finally {
      await page.close();
    }
  });
