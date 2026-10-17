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
        `<div class="cloud-app-canvas" ${authenticated ? 'data-layout-authenticated="true"' : ""} style="${canvasStyle}"><span style="color: var(--ui-surface)"></span><i style="background:var(--ui-canvas)"></i></div></body></html>`,
    );
    return await page.evaluate(() => {
      const canvas = document.querySelector(".cloud-app-canvas")!;
      const { backgroundImage, backgroundColor } = getComputedStyle(canvas);
      if (backgroundImage.startsWith("linear-gradient(")) return "gradient";
      return backgroundImage === "none" && backgroundColor === getComputedStyle(canvas.firstElementChild!).color
        ? "surface"
        : backgroundColor === getComputedStyle(canvas.lastElementChild!).backgroundColor
          ? "canvas"
          : backgroundColor;
    });
  } finally {
    await page.close();
  }
};

// Signed in, the gradient shows behind the app bar from md; anonymous pages show it around their cards.
test("signed-in phones keep the gradient, tablets use neutral canvas, and anonymous phones stay flat", async () => {
  const widths = [390, 767, 768, 1024, 1440, 1536];
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
        widths.map((width) => ({
          authenticated,
          theme,
          width,
          background: authenticated ? (width >= 768 && width < 1024 ? "canvas" : "gradient") : width < 768 ? "surface" : "gradient",
        })),
      ),
    ),
  );
}, 60_000);

// The signed-in shell of Layout.tsx and LayoutRail.tsx. The workspace opens its
// compact sidebar overlay, so the sidebar is measurable in portrait too.
const loadShell = async (width: number, height: number, workspace = false, authenticated = true) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.setContent(`<!doctype html><html><head><style>${insetCss}</style></head><body>
    <div ${authenticated ? 'data-layout-authenticated="true"' : ""} class="cloud-app-canvas relative flex w-full min-h-dvh md:h-dvh md:overflow-hidden">
      ${
        authenticated
          ? `<aside class="layout-rail hidden w-14 shrink-0 flex-col md:flex">
        <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
          <a href="/" aria-label="Home"><span class="block h-5 w-5"></span></a>
        </div>
        <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label="Apps">
          <a class="rail-item" href="/app">App</a>
          <div class="mt-auto shrink-0 flex flex-col items-center gap-1"><a class="rail-item" id="rail-bottom" href="/me">Profile</a></div>
        </nav>
      </aside>`
          : ""
      }
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
  [834, 1194],
  [1194, 834],
  [1440, 900],
] as const) {
  const card = width >= 1024;
  // The card keeps whole pixels: 6 px at 1194 px, 8 px from 1440 px.
  const inset = card ? Math.round(Math.min(8, 4 + (width - 1024) / 104)) : 28;
  test(`${width}×${height}: regular shell keeps clear of the safe areas and scrolls above the home indicator`, async () => {
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
      const padding = shape.padding.map(Number.parseFloat);
      for (const [index, expected] of (card ? [24, 12, inset, 0] : [32, 20, 28, 24]).entries())
        expect(Math.abs(padding[index]! - expected)).toBeLessThanOrEqual(0.05);
      expect(shape.rail.left).toBeCloseTo(card ? 0 : 24, 1);
      expect(shape.rail.top).toBeCloseTo(card ? 24 : 32, 1);
      expect(Math.abs(shape.rail.bottom - (height - inset))).toBeLessThanOrEqual(0.05);
      expect(shape.rail.width).toBeCloseTo(card ? 56 + 16 : 60, 1);
      expect(shape.logo.top).toBeGreaterThanOrEqual(24);
      expect(shape.logo.left).toBeGreaterThanOrEqual(16);
      expect(shape.railBottom).toBeLessThanOrEqual(card ? height - 20 + 1 : height - 28 - 8 + 1);
      expect(shape.shell.top).toBeCloseTo(card ? 24 : 32, 1);
      expect(shape.shell.right).toBeCloseTo(width - (card ? 12 : 20), 1);
      expect(Math.abs(shape.shell.bottom - (height - inset))).toBeLessThanOrEqual(0.05);
      expect(Math.abs(shape.mainBottom - (height - inset))).toBeLessThanOrEqual(0.05);
      expect(shape.scrollTop).toBeGreaterThan(0);
      expect(Math.abs(shape.lastBottom - (height - (card ? 20 : 28)))).toBeLessThanOrEqual(1);
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
      expect(Math.abs(shape.workspace.bottom - (height - inset))).toBeLessThanOrEqual(0.05);
      expect(shape.mainPadding).toBe("0px");
      for (const surface of [shape.main, shape.sidebar]) {
        expect(Math.abs(surface.bottom - (height - inset))).toBeLessThanOrEqual(1);
        expect(Math.abs(surface.border - Math.max(0, 20 - inset))).toBeLessThanOrEqual(0.05);
        expect(Math.abs(surface.bottom - surface.border - (height - Math.max(20, inset)))).toBeLessThanOrEqual(1);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const width of [390, 1440]) {
  test(`${width}px: phone and anonymous shell padding stay unchanged with safe areas`, async () => {
    const page = await loadShell(width, 820, false, width === 390);
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
      expect(shape.padding).toEqual(width === 390 ? ["24px", "12px", "0px", "16px"] : Array(4).fill(shape.shellSpacing));
    } finally {
      await page.close();
    }
  }, 30_000);
}
