import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { workspaceCss, workspaceDist, workspaceFrames, workspaceTree } from "../../test/workspace-host-fixture";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-resize-cue-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { default: ResizeSeparator } = await import("./ResizeSeparator");
const entry = resolve(import.meta.dir, "resize-cue.client-fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
      import { installAppWorkspaceController, attachResizeSeparator } from ${JSON.stringify(resolve(workspaceDist, "browser/index.js"))};
      installAppWorkspaceController();
      for (const handle of document.querySelectorAll(".k2b-resize-separator")) {
        const region = document.getElementById(handle.getAttribute("aria-controls"));
        const property = handle.getAttribute("aria-orientation") === "horizontal" ? "height" : "width";
        let value = 240;
        attachResizeSeparator(handle, {
          min: 160, max: 400, value: () => value, step: 8,
          grow: handle.dataset.resizeEdge,
          onResize: next => { value = next; region.style[property] = next + "px"; },
          onReset: () => {
            value = 240;
            region.style[property] = "240px";
            handle.setAttribute("aria-valuenow", "240");
          }
        });
      }
    `,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle resize cue fixture");
const script = await build.outputs[0]!.text();
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

type Edge = {
  selector: string;
  axis: "width" | "height";
  edge: "start" | "end";
  active: "data-workspace-resize-active" | "data-active";
  drawer?: boolean;
};
const workspaceEdges: Edge[] = [
  { selector: '[data-app-workspace-resize="sidebar"]', axis: "width", edge: "end", active: "data-workspace-resize-active" },
  { selector: '[data-app-workspace-resize="pane"]', axis: "width", edge: "end", active: "data-workspace-resize-active" },
  { selector: '[data-app-workspace-resize="detail"]', axis: "width", edge: "start", active: "data-workspace-resize-active" },
  { selector: '[data-app-workspace-resize="drawer"]', axis: "height", edge: "start", active: "data-workspace-resize-active", drawer: true },
];
const separatorEdges: Edge[] = [
  { selector: '[aria-controls="start-region"]', axis: "width", edge: "start", active: "data-active" },
  { selector: '[aria-controls="end-region"]', axis: "width", edge: "end", active: "data-active" },
  { selector: '[aria-controls="row-region"]', axis: "height", edge: "end", active: "data-active" },
];

function separators() {
  return separatorEdges
    .map(({ axis, edge }, index) => {
      const id = ["start-region", "end-region", "row-region"][index]!;
      const handle = renderToString(() =>
        createComponent(ResizeSeparator, {
          label: `Resize ${id}`,
          orientation: axis === "width" ? "vertical" : "horizontal",
          controls: id,
          grow: edge,
          value: 240,
          min: 160,
          max: 400,
          onResize: () => {},
        }),
      );
      const region = `<div id="${id}" data-cue-region style="flex:none;${axis}:240px;background:var(--k2b-surface-subtle)">Region</div>`;
      return `<div data-cue-region style="display:flex;flex-direction:${axis === "width" ? "row" : "column"};width:680px;height:${axis === "width" ? 140 : 400}px;margin:16px">
      ${edge === "end" ? region + handle : handle + region}<div style="flex:1"></div></div>`;
    })
    .join("");
}

async function load(group: "workspace" | "separators") {
  const html =
    group === "workspace" ? renderToString(() => workspaceTree({ AppWorkspace, createComponent, createSignal, Dynamic })) : separators();
  const page = await browser.newPage({ viewport: { width: 2000, height: 1000 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  try {
    await page.route("http://resize.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" style="margin:0"><button id="park" style="position:fixed;right:0;top:0;z-index:100">Away</button>
      <span id="focus-swatch" style="position:fixed;background:var(--k2b-focus-ring);pointer-events:none"></span>
      <div style="container:k2b-app-area / inline-size"><div id="app" style="height:900px">${html}</div></div></body></html>`,
      }),
    );
    await page.goto("http://resize.test/");
    await page.addScriptTag({ content: script });
    await settled(page);
    return { page, errors };
  } catch (error) {
    await page.close();
    throw error;
  }
}

function geometry() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".k2b-app-workspace__sidebar, [data-workspace-main-region], .k2b-app-workspace__main-primary, .k2b-app-workspace__detail, .k2b-app-workspace__drawer, [data-app-workspace-resize], [data-cue-region], .k2b-resize-separator",
    ),
  ).map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}

async function cue(page: Page, selector: string) {
  // settled: callers wait two frames or for the requested size before inspecting the paint-only cue.
  return page.locator(selector).evaluate((handle) => {
    const shadow = getComputedStyle(handle, "::after");
    const line = getComputedStyle(handle, "::before");
    const grip = getComputedStyle(handle.querySelector("span")!);
    const { width, height } = handle.getBoundingClientRect();
    return {
      content: shadow.content,
      opacity: shadow.opacity,
      left: Number.parseFloat(shadow.left),
      right: Number.parseFloat(shadow.right),
      top: Number.parseFloat(shadow.top),
      bottom: Number.parseFloat(shadow.bottom),
      shadowWidth: Number.parseFloat(shadow.width),
      shadowHeight: Number.parseFloat(shadow.height),
      width,
      height,
      line: line.content !== "none" && line.content !== "normal" && line.display !== "none",
      grip: grip.opacity,
      background: grip.backgroundColor,
      focusColor: getComputedStyle(document.getElementById("focus-swatch")!).backgroundColor,
      shadowTransition: shadow.transitionDuration,
      gripTransition: grip.transitionDuration,
    };
  });
}

async function size(page: Page, { selector, axis }: Edge) {
  // settled: callers wait for the requested size or for the initial fixture to settle.
  return page.locator(selector).evaluate(
    (handle, axis) => ({
      aria: Number(handle.getAttribute("aria-valuenow")),
      rendered: document.getElementById(handle.getAttribute("aria-controls")!)!.getBoundingClientRect()[axis],
    }),
    axis,
  );
}

async function waitSize(page: Page, spec: Edge, requested: number) {
  try {
    await page.waitForFunction(
      ({ selector, axis, requested }) => {
        const handle = document.querySelector(selector)!;
        const region = document.getElementById(handle.getAttribute("aria-controls")!)!;
        return (
          Math.abs(Number(handle.getAttribute("aria-valuenow")) - requested) <= 0.5 &&
          Math.abs(region.getBoundingClientRect()[axis] - requested) <= 0.5
        );
      },
      { selector: spec.selector, axis: spec.axis, requested },
      { timeout: 3000 },
    );
  } catch (cause) {
    const current = await size(page, spec);
    throw new Error(`${spec.selector}: requested ${requested}px; current aria-valuenow=${current.aria}, rendered=${current.rendered}px`, {
      cause,
    });
  }
}

async function away(page: Page) {
  await page.locator("#park").click();
  await workspaceFrames(page);
}

async function exercise(page: Page, spec: Edge) {
  const handle = page.locator(spec.selector);
  await away(page);
  const initial = await size(page, spec);
  expect(Math.abs(initial.aria - initial.rendered)).toBeLessThanOrEqual(0.5);
  const baseline = await page.evaluate(geometry);
  const idle = await cue(page, spec.selector);
  // Every edge renders its shadow; without it (the Detail handle before this fix) there is no ::after at all.
  expect(idle.content).not.toBe("none");
  expect(idle.content).not.toBe("normal");
  expect(idle.opacity).toBe("0");
  expect(idle.grip).toBe("0");
  expect(idle.shadowTransition).toBe("0s");
  expect(idle.gripTransition).toBe("0s");

  await handle.hover();
  await workspaceFrames(page);
  // settled: hover has painted for two frames; it must not move any region or handle.
  expect(await page.evaluate(geometry)).toEqual(baseline);
  const hovered = await cue(page, spec.selector);
  expect(hovered.opacity).toBe("1");
  expect(hovered.grip).toBe("1");
  await page.mouse.down();
  await workspaceFrames(page);
  // settled: a press without movement has painted for two frames.
  expect(await page.evaluate(geometry)).toEqual(baseline);
  await page.mouse.up();
  await away(page);

  await handle.hover();
  await workspaceFrames(page);
  // settled: use the current handle center after hover.
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Missing ${spec.selector}`);
  await page.mouse.down();
  const delta = spec.edge === "start" ? -8 : 8;
  await page.mouse.move(
    box.x + box.width / 2 + (spec.axis === "width" ? delta : 0),
    box.y + box.height / 2 + (spec.axis === "height" ? delta : 0),
  );
  await waitSize(page, spec, initial.rendered + 8);
  expect(await handle.getAttribute(spec.active)).toBe("true");
  const dragging = await cue(page, spec.selector);
  expect(dragging.content).not.toBe("none");
  expect(dragging.content).not.toBe("normal");
  expect(dragging.opacity).toBe("1");
  expect(dragging.grip).toBe("1");
  expect(dragging.line).toBe(spec.drawer === true);
  if (spec.axis === "width") {
    expect(spec.edge === "start" ? dragging.left : dragging.right).toBeCloseTo(dragging.width / 2, 1);
    expect(dragging.shadowWidth).toBeGreaterThan(0);
  } else {
    expect(spec.edge === "start" ? dragging.top : dragging.bottom).toBeCloseTo(dragging.height / 2, 1);
    expect(dragging.shadowHeight).toBeGreaterThan(0);
  }
  await page.mouse.up();
  await away(page);
  expect(await handle.getAttribute(spec.active)).toBeNull();
  expect((await cue(page, spec.selector)).opacity).toBe("0");
  expect((await cue(page, spec.selector)).grip).toBe("0");

  await handle.dblclick();
  await waitSize(page, spec, initial.rendered);
  await away(page);
  // Enter keyboard modality before focusing; the pointer stays away from the handle.
  await page.keyboard.press("Tab");
  await handle.focus();
  await workspaceFrames(page);
  const focused = await cue(page, spec.selector);
  expect(focused.grip).toBe("1");
  expect(focused.opacity).toBe("1");
  expect(focused.background).toBe(focused.focusColor);
  const increase =
    spec.axis === "width" ? (spec.edge === "start" ? "ArrowLeft" : "ArrowRight") : spec.edge === "start" ? "ArrowUp" : "ArrowDown";
  const decrease =
    spec.axis === "width" ? (spec.edge === "start" ? "ArrowRight" : "ArrowLeft") : spec.edge === "start" ? "ArrowDown" : "ArrowUp";
  await page.keyboard.press(increase);
  await waitSize(page, spec, initial.rendered + 8);
  // Same page, same handle: #1525 lost this second arrow in WebKit.
  await page.keyboard.press(decrease);
  await waitSize(page, spec, initial.rendered);
  await page.keyboard.press(increase);
  await waitSize(page, spec, initial.rendered + 8);
  await handle.dblclick();
  await waitSize(page, spec, initial.rendered);
  await away(page);
}

for (const group of ["workspace", "separators"] as const)
  test(`${group}: every edge shares its cue, stable geometry, keyboard steps and reset`, async () => {
    const { page, errors } = await load(group);
    try {
      const edges = group === "workspace" ? workspaceEdges : separatorEdges;
      for (const spec of edges) await exercise(page, spec);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await settled(page);
      for (const spec of edges) {
        const motion = await cue(page, spec.selector);
        expect(motion.shadowTransition).not.toBe("0s");
        expect(motion.gripTransition).not.toBe("0s");
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
