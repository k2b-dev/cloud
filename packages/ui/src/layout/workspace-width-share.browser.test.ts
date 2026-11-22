import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import {
  clientFixture,
  type FixtureOptions,
  workspaceCss,
  workspaceDist,
  workspaceFrames,
  workspaceTree,
} from "../../test/workspace-host-fixture";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-share-"));
registerSsrTestPlugin({ dev: true, rootDir: directory });

process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
// Primary has no stylesheet minimum of its own; the platform keeps it at Main's 320 px minimum when a pane grows.
const { APP_WORKSPACE_MAIN_MIN } = await import("./app-workspace-state");
const script = await clientFixture();
const controllerEntry = resolve(directory, "controller.ts");
const controllerBuild = await Bun.build({
  entrypoints: [controllerEntry],
  files: {
    [controllerEntry]: `import { installAppWorkspaceController } from ${JSON.stringify(resolve(workspaceDist, "browser/index.js"))};
      window.stopWorkspaceController = installAppWorkspaceController({readState: () => JSON.parse(document.body.dataset.options).layoutState});`,
  },
  target: "browser",
  format: "iife",
});
if (!controllerBuild.success) throw new AggregateError(controllerBuild.logs, "Could not bundle share controller fixture");
const controller = await controllerBuild.outputs[0]!.text();
const css = workspaceCss();
const paneSize = { share: 0.25, offset: -12, min: 332, max: 452 };
const mainMin = { share: 0.25, offset: 428, min: 772, max: 892 };
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

function frame() {
  const root = document.querySelector<HTMLElement>(".k2b-app-workspace")!;
  const main = root.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
  const pane = root.querySelector<HTMLElement>(".k2b-app-workspace__main-pane")!;
  const primary = root.querySelector<HTMLElement>(".k2b-app-workspace__main-primary")!;
  const detail = root.querySelector<HTMLElement>(".k2b-app-workspace__detail")!;
  const sidebar = root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar")!;
  const box = (element: HTMLElement) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    root: box(root),
    main: box(main),
    pane: box(pane),
    primary: box(primary),
    detail: box(detail),
    column: getComputedStyle(detail).display !== "none",
    // The sidebar's column width; an overlay sidebar takes no column.
    sidebar:
      getComputedStyle(sidebar).display !== "none" && getComputedStyle(sidebar).position !== "absolute"
        ? sidebar.getBoundingClientRect().width
        : 0,
    workspaceWidth: Number.parseFloat(
      getComputedStyle(main.closest<HTMLElement>(".k2b-app-workspace__content")!).getPropertyValue("--k2b-workspace-width"),
    ),
  };
}

async function load(
  width: number,
  sidebarWidth = 240,
  minimum: FixtureOptions["mainMin"] = mainMin,
  islands = false,
  detailWidths?: Record<string, number>,
) {
  const options: FixtureOptions = {
    mainMin: minimum,
    paneSize,
    detailWidth: "lg",
    layoutState: { version: 2, sidebarWidth, detailWidths },
  };
  let html = renderToString(() => workspaceTree({ AppWorkspace, createComponent, createSignal, Dynamic }, options));
  if (islands) {
    // Main may be an island while Content remains the shared grid region.
    const start = html.indexOf('<div class="k2b-app-workspace__main ');
    const end = html.indexOf("<style>.k2b-app-workspace:has(", start);
    if (start < 0 || end < 0) throw new Error("Could not find Main and the following Detail rule");
    html = html.slice(0, start) + "<solid-island>" + html.slice(start, end) + "</solid-island>" + html.slice(end);
  }
  const page = await browser.newPage({ viewport: { width: Math.max(1600, width + 128), height: 900 }, reducedMotion: "reduce" });
  const document = `<!doctype html><html><head><style>${css}</style><style>solid-client,solid-island{display:contents}</style></head><body class="k2b-ui" style="margin:0">
    <div style="container:k2b-app-area / inline-size;width:${width + 64}px"><div id="app" style="height:900px;margin-inline:32px">${html}</div></div></body></html>`;
  try {
    await page.route("http://workspace.test/**", (route) => route.fulfill({ contentType: "text/html", body: document }));
    await page.goto("http://workspace.test/");
    await page.evaluate((options) => {
      window.document.body.dataset.options = JSON.stringify(options);
    }, options);
    return { page, options };
  } catch (error) {
    await page.close();
    throw error;
  }
}

function expectedFrame(actual: Awaited<ReturnType<typeof frame>>, width: number, minimum: FixtureOptions["mainMin"] = mainMin) {
  const pane = Math.min(452, Math.max(332, width * 0.25 - 12));
  expect(Math.abs(actual.root.width - width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(actual.pane.width - pane)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(actual.workspaceWidth - width)).toBeLessThanOrEqual(0.5);
  const min = typeof minimum === "number" ? minimum : pane + 440;
  // The lg Detail is 480 px; the flat column has no inset of its own (K5a), so the threshold no longer adds 8 px.
  expect(actual.column).toBe(width - 2 - actual.sidebar - 480 >= min);
  // Main keeps its minimum beside the Detail; the pane's boundary inside Main is part of that minimum.
  if (actual.column) expect(actual.main.width).toBeGreaterThanOrEqual(min - 0.5);
  expect(actual.primary.width).toBeGreaterThanOrEqual(APP_WORKSPACE_MAIN_MIN - 0.5);
}

function sameFrame(actual: ReturnType<typeof frame>, expected: ReturnType<typeof frame>) {
  expect(actual.column).toBe(expected.column);
  expect(actual.sidebar).toBe(expected.sidebar);
  for (const region of ["root", "main", "pane", "primary", "detail"] as const)
    for (const dimension of ["x", "y", "width", "height"] as const)
      expect(Math.abs(actual[region][dimension] - expected[region][dimension])).toBeLessThanOrEqual(0.5);
}

for (const width of [1376, 1456, 1536, 1600, 1856, 2496, 952, 1462]) {
  test(`${width}px: workspace share has identical server, attached, reload and client frames`, async () => {
    const { page, options } = await load(width);
    try {
      // settled: the server frame before JS is the subject.
      const server = await page.evaluate(frame);
      expectedFrame(server, width);
      await page.addScriptTag({ content: controller });
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
      expect(
        await page
          .locator(".k2b-app-workspace")
          .evaluate((root) => (root as HTMLElement).style.getPropertyValue("--k2b-workspace-pane-navigation-width")),
      ).toBe("");
      await page.reload();
      // settled: the reloaded server frame is the subject.
      sameFrame(await page.evaluate(frame), server);
      await page.evaluate((options) => {
        document.body.dataset.options = JSON.stringify(options);
        document.getElementById("app")!.innerHTML = "";
      }, options);
      await page.addScriptTag({ content: script });
      // settled: the client-rendered first frame is the subject.
      sameFrame(await page.evaluate(frame), server);
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
      const handle = page.locator('[data-app-workspace-resize="pane"]');
      expect(Math.abs(Number(await handle.getAttribute("aria-valuenow")) - server.pane.width)).toBeLessThanOrEqual(0.5);
    } finally {
      await page.close();
    }
  });
}

// The layout cookie's Detail width is part of the server output (an inline variable), and the stylesheet bounds it by
// the room beside Main's minimum in that first frame, so a width saved in a wider window arrives at the width it keeps:
// the controller, a reload, and a client render move nothing.
// Main's default 320 px minimum and a share minimum; from about 1700 px the Detail's own 640 px maximum bounds it
// before the window does. Before the fix the controller reserved the old 8 px inset and moved the Detail from 538 to
// 530 px (1100) and from 632 to 624 px (1194) as it attached.
for (const [width, minimum] of [
  [1100, 320],
  [1194, 320],
  [1536, mainMin],
  [1600, mainMin],
] as const) {
  test(`${width}px, Main ${typeof minimum === "number" ? `${minimum}px` : "share"}: a Detail saved wider than the window arrives bounded in the server frame, and nothing moves after it`, async () => {
    const { page, options } = await load(width, 240, minimum, false, { contact: 900 });
    try {
      // settled: the server frame before JS is the subject.
      const server = await page.evaluate(frame);
      expect(server.column).toBe(true);
      const min = typeof minimum === "number" ? minimum : Math.min(452, Math.max(332, width * 0.25 - 12)) + 440;
      // Bounded: Main keeps exactly its minimum and the Detail takes the rest of the workspace.
      expect(Math.abs(server.main.width - min)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(server.detail.width - (width - 2 - server.sidebar - min))).toBeLessThanOrEqual(0.5);
      expect(server.detail.width).toBeLessThan(900);
      await page.addScriptTag({ content: controller });
      await workspaceFrames(page);
      // settled: the frame two frames after the controller attached is the subject.
      sameFrame(await page.evaluate(frame), server);
      await page.reload();
      // settled: the reloaded server frame is the subject.
      sameFrame(await page.evaluate(frame), server);
      await page.evaluate((options) => {
        document.body.dataset.options = JSON.stringify(options);
        document.getElementById("app")!.innerHTML = "";
      }, options);
      await page.addScriptTag({ content: script });
      // settled: the client-rendered first frame is the subject.
      sameFrame(await page.evaluate(frame), server);
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
    } finally {
      await page.close();
    }
  });
}

for (const sidebar of [176, 360]) {
  test(`1600px: a stored ${sidebar}px sidebar moves the share Detail threshold before JS`, async () => {
    const { page } = await load(1600, sidebar);
    try {
      // settled: the server frame before JS is the subject.
      const server = await page.evaluate(frame);
      expectedFrame(server, 1600);
      expect(server.sidebar).toBe(sidebar);
      expect(server.column).toBe(sidebar === 176);
      await page.addScriptTag({ content: controller });
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
    } finally {
      await page.close();
    }
  });
}

for (const width of [1456, 1600]) {
  test(`${width}px: numeric Main minimum retains its fixed threshold`, async () => {
    const { page } = await load(width, 240, 760);
    try {
      // settled: the server frame before JS is the subject.
      const server = await page.evaluate(frame);
      expectedFrame(server, width, 760);
      await page.addScriptTag({ content: controller });
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
    } finally {
      await page.close();
    }
  });
}

test("share default resets on double-click after a keyboard resize; limits resolve Main's share in pixels", async () => {
  const { page } = await load(1600);
  try {
    await page.addScriptTag({ content: controller });
    await workspaceFrames(page);
    const pane = page.locator('[data-app-workspace-resize="pane"]');
    const sidebar = page.locator('[data-app-workspace-resize="sidebar"]');
    expect(Number(await sidebar.getAttribute("aria-valuemax"))).toBeLessThanOrEqual(1600 - 2 - 828);
    await pane.focus();
    await page.keyboard.press("ArrowRight");
    await settled(page);
    expect((await page.evaluate(frame)).pane.width).toBeGreaterThan(388);
    // At the pane's end the reader keeps Primary's minimum.
    await page.keyboard.press("End");
    await settled(page);
    expect((await page.evaluate(frame)).primary.width).toBeGreaterThanOrEqual(APP_WORKSPACE_MAIN_MIN - 0.5);
    await pane.dblclick();
    await settled(page);
    expect((await page.evaluate(frame)).pane.width).toBeCloseTo(388, 0);
    // The default follows the workspace again, rather than keeping a reset px width.
    await page.locator("#app").evaluate((app) => {
      app.parentElement!.style.width = "1600px";
    });
    await settled(page);
    expectedFrame(await page.evaluate(frame), 1536);
  } finally {
    await page.close();
  }
});

test("island-wrapped Main inherits the resolved workspace width", async () => {
  const { page } = await load(1456, 240, mainMin, true);
  try {
    // settled: the server frame before JS is the subject.
    const server = await page.evaluate(frame);
    expectedFrame(server, 1456);
    await page.addScriptTag({ content: controller });
    await workspaceFrames(page);
    // settled: the frame two frames after this step is the subject.
    sameFrame(await page.evaluate(frame), server);
  } finally {
    await page.close();
  }
});

for (const [width, sidebar] of [
  [436, 240],
  [1036, 360],
] as const) {
  test(`${width}px: the host bound agrees in padding, grid and inherited width`, async () => {
    const { page } = await load(width, sidebar);
    try {
      // settled: the server frame before JS is the subject.
      const server = await page.evaluate(frame);
      expect(Math.abs(server.root.width - width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(server.workspaceWidth - width)).toBeLessThanOrEqual(0.5);
      expect(server.main.x + server.main.width).toBeLessThanOrEqual(server.root.x + server.root.width + 0.5);
      expect(server.column).toBe(false);
      expect(server.sidebar).toBe(0);
      await page.addScriptTag({ content: controller });
      await workspaceFrames(page);
      // settled: the frame two frames after this step is the subject.
      sameFrame(await page.evaluate(frame), server);
    } finally {
      await page.close();
    }
  });
}
