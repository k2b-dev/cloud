import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAppearanceStyle } from "../ssr/app-appearance";

// happy-dom drops the canvas gradient because it cannot resolve nested var()
// fallbacks, so only a real engine shows which background rule wins.
let browser: Browser;
let css: string;
let insetCss: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  // Engines cannot override env(), so emulate the installed app in the compiled stylesheet.
  insetCss = css;
  for (const [side, inset] of Object.entries({ top: 24, right: 12, bottom: 20, left: 16 })) {
    let replaced = 0;
    insetCss = insetCss.replace(new RegExp(`env\\(\\s*safe-area-inset-${side}\\s*(?:,\\s*0px\\s*)?\\)`, "g"), () => {
      replaced++;
      return `${inset}px`;
    });
    expect(replaced).toBeGreaterThan(0);
  }
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Spaces' appearance, written onto the canvas as the shell does for its routes.
const canvasStyle = appAppearanceStyle({ accent: "#4d7c0f", background: { from: "#65a30d", to: "#84cc16", angle: 135 } });

const canvasBackground = async (theme: "light" | "dark", width: number, authenticated: boolean) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(
      `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body>` +
        `<div class="cloud-app-canvas" ${authenticated ? 'data-layout-authenticated="true"' : ""} style="${canvasStyle}"><span style="color: var(--ui-surface)"></span></div></body></html>`,
    );
    return await page.evaluate(() => {
      const canvas = document.querySelector(".cloud-app-canvas")!;
      const { backgroundImage, backgroundColor } = getComputedStyle(canvas);
      if (backgroundImage.startsWith("linear-gradient(")) return "gradient";
      return backgroundImage === "none" && backgroundColor === getComputedStyle(canvas.firstElementChild!).color
        ? "surface"
        : backgroundColor;
    });
  } finally {
    await page.close();
  }
};

// Signed in, the gradient shows behind the app bar from md; anonymous pages show it around their cards.
test("phones get the flat surface in both themes and the app gradient starts at md", async () => {
  const widths = [390, 767, 768, 1440, 1536];
  const actual = [];
  for (const authenticated of [false, true]) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of widths)
        actual.push({ authenticated, theme, width, background: await canvasBackground(theme, width, authenticated) });
    }
  }
  expect(actual).toEqual(
    [false, true].flatMap((authenticated) =>
      (["light", "dark"] as const).flatMap((theme) =>
        widths.map((width) => ({ authenticated, theme, width, background: width < 768 ? "surface" : "gradient" })),
      ),
    ),
  );
}, 60_000);

// The signed-in shell of Layout.tsx and LayoutRail.tsx. The workspace opens its
// compact sidebar overlay, so the sidebar is measurable in portrait too.
const loadShell = async (width: number, height: number, workspace = false) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.setContent(`<!doctype html><html><head><style>${insetCss}</style></head><body>
    <div data-layout-authenticated="true" class="cloud-app-canvas relative flex w-full min-h-dvh md:h-dvh md:overflow-hidden">
      <aside class="layout-rail hidden w-10 shrink-0 flex-col md:flex">
        <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
          <a href="/" aria-label="Home"><span class="block h-5 w-5"></span></a>
        </div>
        <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label="Apps">
          <a href="/app">App</a>
          <div class="mt-auto shrink-0 flex flex-col items-center gap-1"><a id="rail-bottom" href="/me">Profile</a></div>
        </nav>
      </aside>
      <div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col">
        <main class="layout-content-main min-h-0 min-w-0 flex-1 md:overflow-auto md:[scrollbar-gutter:stable]">
          ${
            workspace
              ? `<div class="k2b-ui h-full"><div class="k2b-app-workspace" data-sidebar-overlay="open">
            <aside class="k2b-app-workspace__sidebar"><div class="k2b-app-workspace__sidebar-desktop">Navigation</div></aside>
            <div class="k2b-app-workspace__content"><div class="k2b-app-workspace__main">Workspace</div></div>
          </div></div>`
              : `<div style="height:2000px"></div><div id="page-last" style="height:40px">End of page</div>`
          }
        </main>
      </div>
    </div>
  </body></html>`);
  return page;
};

for (const [width, height] of [
  [1180, 820],
  [820, 1180],
] as const) {
  test(`${width}×${height}: regular shell fills the safe areas and scrolls above the home indicator`, async () => {
    const page = await loadShell(width, height);
    try {
      const shape = await page.evaluate(async () => {
        const canvas = document.querySelector(".cloud-app-canvas")!;
        const style = getComputedStyle(canvas);
        const spacing = document.createElement("span");
        spacing.style.width = style.getPropertyValue("--ui-space-shell");
        canvas.append(spacing);
        const shellSpacing = Number.parseFloat(getComputedStyle(spacing).width);
        spacing.remove();
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width };
        };
        const main = document.querySelector<HTMLElement>(".layout-content-main")!;
        main.scrollTop = main.scrollHeight;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          shellSpacing,
          rail: box(".layout-rail"),
          logo: box(".layout-rail-logo"),
          railBottom: box("#rail-bottom").bottom,
          shell: box(".layout-shell-content"),
          mainBottom: box(".layout-content-main").bottom,
          lastBottom: box("#page-last").bottom,
          scrollTop: main.scrollTop,
        };
      });
      expect(shape.padding).toEqual(["0px", "0px", "0px", "0px"]);
      expect(shape.rail.left).toBeCloseTo(0, 1);
      expect(shape.rail.top).toBeCloseTo(0, 1);
      expect(shape.rail.bottom).toBeCloseTo(height, 1);
      expect(shape.rail.width).toBeCloseTo(48 + 16, 1);
      expect(shape.logo.top).toBeGreaterThanOrEqual(24);
      expect(shape.logo.left).toBeGreaterThanOrEqual(16);
      expect(shape.railBottom).toBeLessThanOrEqual(height - 20 - shape.shellSpacing + 1);
      expect(shape.shell.top).toBeCloseTo(0, 1);
      expect(shape.shell.right).toBeCloseTo(width, 1);
      expect(shape.shell.bottom).toBeCloseTo(height, 1);
      expect(shape.mainBottom).toBeCloseTo(height, 1);
      expect(shape.scrollTop).toBeGreaterThan(0);
      expect(Math.abs(shape.lastBottom - (height - 20))).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`${width}×${height}: workspace surfaces fill the bottom inset inside the shell`, async () => {
    const page = await loadShell(width, height, true);
    try {
      const shape = await page.evaluate(() => {
        const surface = (selector: string) => {
          const element = document.querySelector(selector)!;
          return { bottom: element.getBoundingClientRect().bottom, border: Number.parseFloat(getComputedStyle(element).borderBottomWidth) };
        };
        return {
          workspace: surface(".k2b-app-workspace"),
          main: surface(".k2b-app-workspace__main"),
          sidebar: surface(".k2b-app-workspace__sidebar"),
          mainPadding: getComputedStyle(document.querySelector(".layout-content-main")!).paddingBottom,
        };
      });
      expect(shape.workspace.bottom).toBeCloseTo(height, 1);
      expect(shape.mainPadding).toBe("0px");
      for (const surface of [shape.main, shape.sidebar]) {
        expect(surface.bottom).toBeCloseTo(height, 1);
        expect(surface.border).toBe(20);
        expect(surface.bottom - surface.border).toBeCloseTo(height - 20, 1);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const width of [390, 1536]) {
  test(`${width}px: phone and card shell padding stay unchanged with safe areas`, async () => {
    const page = await loadShell(width, 820);
    try {
      const shape = await page.evaluate(() => {
        const canvas = document.querySelector(".cloud-app-canvas")!;
        const style = getComputedStyle(canvas);
        const spacing = document.createElement("span");
        spacing.style.width = style.getPropertyValue("--ui-space-shell");
        canvas.append(spacing);
        const shellSpacing = getComputedStyle(spacing).width;
        spacing.remove();
        return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], shellSpacing };
      });
      expect(shape.padding).toEqual(width === 390 ? ["24px", "12px", "20px", "16px"] : Array(4).fill(shape.shellSpacing));
    } finally {
      await page.close();
    }
  }, 30_000);
}
