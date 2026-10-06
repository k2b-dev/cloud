import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Whether hidden navigation really frees its track, takes the navigation pane
// with it and snaps away under a drag depends on real layout, so a real engine
// runs the shipped browser build at desktop and phone widths.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-hidden.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [hidden, setHidden] = createSignal(false);
window.fixture = { hidden, setHidden };

render(
  () =>
    createComponent(AppWorkspace, {
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            id: "navigation",
            label: "Navigation",
            get hidden() {
              return hidden();
            },
            onHiddenChange: setHidden,
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return createComponent(AppWorkspace.SidebarItem, { href: "#private", children: "Private folder" });
                },
              });
            },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, {
                scroll: false,
                get children() {
                  return [
                    createComponent(AppWorkspace.MainPane, {
                      id: "notes",
                      label: "Notes",
                      surface: "navigation",
                      get children() {
                        return hidden() ? null : "Team notes";
                      },
                    }),
                    "Editor",
                  ];
                },
              });
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the hidden sidebar fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Box = { display: string; left: number; opacity: string; width: number } | null;
type Layout = { sidebar: Box; pane: Box; main: Box; workspace: Box; handles: number; privateText: boolean };

const load = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__main-primary").waitFor();
  return page;
};

const layout = (page: Page): Promise<Layout> =>
  page.evaluate(async () => {
    // Pointer resizing applies once per animation frame.
    await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { display: style.display, left: Math.round(rect.left), opacity: style.opacity, width: Math.round(rect.width) };
    };
    return {
      sidebar: box(".k2b-app-workspace__sidebar"),
      pane: box(".k2b-app-workspace__main-pane[data-surface='navigation']"),
      main: box(".k2b-app-workspace__main-primary"),
      workspace: box(".k2b-app-workspace"),
      handles: Array.from(document.querySelectorAll<HTMLElement>("[data-app-workspace-resize]")).filter(
        (handle) => getComputedStyle(handle).display !== "none",
      ).length,
      privateText: document.body.textContent?.includes("Private folder") ?? false,
    };
  });

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => (window as unknown as { fixture: { setHidden: (hidden: boolean) => void } }).fixture.setHidden(value), hidden);

describe("hidden workspace navigation", () => {
  test("at 1440 px hides the sidebar and the navigation pane, and the editor spans the workspace", async () => {
    const page = await load(1440);
    try {
      const visible = await layout(page);
      expect(visible.sidebar?.display).toBe("flex");
      expect(visible.sidebar?.width).toBe(208);
      expect(visible.pane?.display).toBe("flex");
      expect(visible.handles).toBe(2);
      expect(visible.privateText).toBe(true);

      await setHidden(page, true);
      const hidden = await layout(page);
      expect(hidden.sidebar?.display).toBe("none");
      expect(hidden.pane?.display).toBe("none");
      expect(hidden.handles).toBe(0);
      // Not clipped: the navigation content no longer exists.
      expect(hidden.privateText).toBe(false);
      expect(await page.locator("#navigation").getAttribute("hidden")).not.toBeNull();
      expect(hidden.main?.left).toBe(hidden.workspace!.left + 1);
      expect(hidden.main?.width).toBe(hidden.workspace!.width - 2);

      await setHidden(page, false);
      expect(await layout(page)).toEqual(visible);
    } finally {
      await page.close();
    }
  });

  test("at 1440 px a drag below half the minimum width previews and then hides the navigation, and showing it restores the width", async () => {
    const page = await load(1440);
    try {
      const handle = await page.locator('[data-app-workspace-resize="sidebar"]').boundingBox();
      const x = handle!.x + handle!.width / 2;
      const y = handle!.y + 200;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(120, y, { steps: 4 });
      const clamped = await layout(page);
      expect(clamped.sidebar?.display).toBe("flex");
      expect(clamped.sidebar?.width).toBe(176);

      await page.mouse.move(40, y, { steps: 4 });
      // The preview dims the navigation in place: the work area keeps its width until the release.
      const preview = await layout(page);
      expect(preview.sidebar).toEqual({ ...clamped.sidebar!, opacity: "0.5" });
      expect(preview.pane).toEqual({ ...clamped.pane!, opacity: "0.5" });
      expect(preview.main).toEqual(clamped.main);

      await page.mouse.up();
      expect(await page.evaluate(() => (window as unknown as { fixture: { hidden: () => boolean } }).fixture.hidden())).toBe(true);
      const hidden = await layout(page);
      expect(hidden.sidebar?.display).toBe("none");
      expect(hidden.privateText).toBe(false);

      await setHidden(page, false);
      const shown = await layout(page);
      expect(shown.sidebar?.display).toBe("flex");
      expect(shown.sidebar?.width).toBe(208);
      expect(shown.pane?.display).toBe("flex");
    } finally {
      await page.close();
    }
  });

  test("at 390 px the phone layout is the same with a hidden or visible navigation", async () => {
    const page = await load(390);
    try {
      const visible = await layout(page);
      expect(visible.sidebar?.display).toBe("none");
      await setHidden(page, true);
      const hidden = await layout(page);
      expect(hidden.sidebar?.display).toBe("none");
      expect(hidden.main).toEqual(visible.main);
    } finally {
      await page.close();
    }
  });
});
