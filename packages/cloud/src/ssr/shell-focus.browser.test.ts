import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, storedCookie } from "../../../ui/test/browser";

const root = mkdtempSync(resolve(tmpdir(), "cloud-shell-focus-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { server } = await import("./shell-focus.browser-harness");

// Executed inline during parse, before any runtime installs. Reload must not
// resize any shell surface when the runtime starts.
const measure = () => {
  const box = (selector: string) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    };
  };
  return {
    rail: box(".layout-rail"),
    workspace: box(".k2b-app-workspace"),
    main: box(".k2b-app-workspace__main"),
    sidebar: box(".k2b-app-workspace__sidebar"),
    header: box(".layout-header"),
    area: box(".layout-shell-content"),
  };
};
type Rect = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number };
type Boxes = Record<"rail" | "workspace" | "main" | "sidebar" | "header" | "area", Rect>;
const boxes = (page: Page): Promise<Boxes> => page.evaluate(measure);
const initialBoxes = (page: Page): Promise<Boxes> => page.evaluate("window.initialBoxes");
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
let browser: Browser;
let origin: string;
let stop: () => void;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet");
  const css = await build.outputs[0]!.text();
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const entry = resolve(import.meta.dir, "shell-focus.runtime-fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { installAppWorkspaceController } from "@k2b/ui";
import ShellRuntime from "./ShellRuntime.island";
installAppWorkspaceController();
// Run the real command registration and delegation path. The harness removes
// island hydration, leaving the server's two buttons in place.
render(() => createComponent(ShellRuntime, { focus: true, commands: { searchResources: false } }), document.createElement("div"));
`,
    },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-shell-focus-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the shell focus runtime");
  const runtime = await bundle.outputs[0]!.text();
  const served = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/shell-focus-runtime.js")
        return new Response(runtime, { headers: { "content-type": "text/javascript" } });
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const markup = (await response.text())
        .replace(/<script type="module"[^>]*>[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace(
          "</body>",
          `<script>window.initialBoxes=(${measure.toString()})();</script><script src="/shell-focus-runtime.js"></script></body>`,
        );
      return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  origin = `http://localhost:${served.port}`;
  stop = () => served.stop(true);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.close();
  stop?.();
});

const hide = '[data-cloud-shell-focus-toggle="hide"]';
const show = '[data-cloud-shell-focus-toggle="show"]';
for (const [width, height, touch, inset] of [
  [1194, 834, true, 6],
  [834, 1194, true, 8],
  [1440, 900, false, 8],
] as const) {
  test(`${width}x${height}: hide, parse-time reload, keyboard restore and edge gesture preserve geometry`, async () => {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
      locale: "en",
      timezoneId: "UTC",
    });
    try {
      await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: origin }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/app/focus`);
      await settle(page);
      const original = await boxes(page);
      expect(original.rail.width).toBe(width < 1024 ? 60 : 56);
      await page.locator(hide).click();
      await settle(page);
      const hidden = await boxes(page);
      expect(hidden.rail.width).toBe(0);
      expect(hidden.workspace.left).toBe(inset);
      if (width >= 1024) {
        expect(hidden.sidebar.width).toBe(0);
        // The work area starts right inside the card's frame.
        const frame = await page.locator(".k2b-app-workspace").evaluate((element) => element.clientLeft);
        expect(hidden.main.left).toBe(hidden.workspace.left + frame);
        // Resolve round()/clamp() to pixels, as getComputedStyle on the custom
        // property itself returns the unevaluated expression in some engines.
        expect(await page.locator(".cloud-app-canvas").evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))).toBe(
          inset,
        );
      } else {
        expect(hidden.area.left).toBe(8);
        expect(await page.locator(".k2b-app-workspace__head-toggle").isVisible()).toBe(true);
      }
      for (const name of ["workspace", "main"] as const) {
        expect(hidden[name].top).toBe(original[name].top);
        expect(hidden[name].bottom).toBe(original[name].bottom);
      }
      expect(await page.locator(show).evaluate((element) => element === document.activeElement)).toBe(true);
      expect((await storedCookie(page, "cloud_shell_focus"))?.value).toBe("1");
      await page.reload();
      await settle(page);
      expect(await initialBoxes(page)).toEqual(hidden);
      expect(await boxes(page)).toEqual(hidden);
      const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
      await page.keyboard.press(apple ? "Meta+Backslash" : "Control+Backslash");
      await page.waitForFunction(() => !document.querySelector(".cloud-app-canvas")?.hasAttribute("data-shell-focus"));
      await settle(page);
      expect(await boxes(page)).toEqual(original);
      expect(await storedCookie(page, "cloud_shell_focus")).toBeUndefined();
      if (touch) {
        await page.locator(hide).click();
        const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
        // Linux WebKit's device emulation may retain a fine pointer despite
        // hasTouch. Chromium must expose the coarse pointer strip and hit test it.
        if (browserName === "chromium") expect(coarse).toBe(true);
        if (coarse)
          expect(await page.evaluate(() => document.elementFromPoint(5, 400)?.hasAttribute("data-cloud-shell-reveal"))).toBe(true);
        else expect(await page.locator("[data-cloud-shell-reveal]").isVisible()).toBe(false);
        if (browserName === "chromium") {
          const cdp = await context.newCDPSession(page);
          try {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 5, y: 400 }] });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 45, y: 400 }] });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } finally {
            await cdp.detach();
          }
        } else {
          // WebKit has no CDP drag API. Exercise its native PointerEvent path.
          await page.locator("[data-cloud-shell-reveal]").evaluate((strip) => {
            strip.dispatchEvent(
              new PointerEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 5, clientY: 400, bubbles: true }),
            );
            window.dispatchEvent(
              new PointerEvent("pointermove", { pointerType: "touch", pointerId: 1, clientX: 45, clientY: 400, bubbles: true }),
            );
            window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", pointerId: 1, bubbles: true }));
          });
        }
        await settle(page);
        expect(await boxes(page)).toEqual(original);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
test("1194x834: an island-wrapped Main hides its navigation pane with the sidebar", async () => {
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, timezoneId: "UTC" });
  try {
    await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: origin }]);
    const page = await context.newPage();
    await page.goto(`${origin}/app/focus/panes`);
    await settle(page);
    const pane = page.locator('.k2b-app-workspace__main-pane[data-surface="navigation"]');
    expect(await pane.isVisible()).toBe(true);
    await page.locator(hide).click();
    await settle(page);
    expect(await pane.isVisible()).toBe(false);
    expect(await page.locator(".k2b-app-workspace__sidebar").isVisible()).toBe(false);
  } finally {
    await context.close();
  }
});
for (const [width, height] of [
  [694, 834],
  [390, 844],
] as const) {
  test(`${width}x${height}: phones ignore the persisted state`, async () => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, timezoneId: "UTC" });
    try {
      await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: origin }]);
      const page = await context.newPage();
      await page.goto(`${origin}/app/focus`);
      await settle(page);
      const original = await boxes(page);
      await context.addCookies([{ name: "cloud_shell_focus", value: "1", url: origin }]);
      await page.reload();
      await settle(page);
      expect(await initialBoxes(page)).toEqual(original);
      expect(await boxes(page)).toEqual(original);
      expect(await page.locator(hide).isVisible()).toBe(false);
      expect(await page.locator(show).isVisible()).toBe(false);
      expect(await page.locator("[data-cloud-shell-reveal]").isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });
}
