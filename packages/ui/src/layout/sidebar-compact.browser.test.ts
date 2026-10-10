import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Between 48 and 64 rem the sidebar is an overlay that the workspace's compact
// bar opens. Which regions show, what covers what, and where focus goes depend
// on real layout and a real focus model, so a real engine runs the shipped
// browser build of a hydrated workspace, which installs its own controller.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-compact.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const params = new URLSearchParams(window.fixtureParams ?? "");
const item = (label, active) =>
  createComponent(AppWorkspace.SidebarItem, { href: "#" + label.toLowerCase(), active, children: label });

render(
  () =>
    createComponent(LocaleProvider, {
      locale: params.get("locale") ?? "en",
      get children() {
        return createComponent(AppWorkspace, {
          layoutState: () => (params.get("collapsed") ? { version: 2, sidebarCollapsed: true } : null),
          get children() {
            return [
              createComponent(AppWorkspace.Sidebar, {
                id: "navigation",
                label: "Navigation",
                collapsible: true,
                get children() {
                  return createComponent(AppWorkspace.SidebarDesktop, {
                    get children() {
                      return [
                        createComponent(AppWorkspace.SidebarBody, {
                          sidebarMode: "expanded",
                          get children() {
                            return [item("Projects", false), item("Reports", true), item("Archive", false)];
                          },
                        }),
                        createComponent(AppWorkspace.SidebarBody, { sidebarMode: "collapsed", children: "Rail icons" }),
                      ];
                    },
                  });
                },
              }),
              createComponent(AppWorkspace.Content, {
                get children() {
                  return [
                    createComponent(AppWorkspace.Main, {
                      get children() {
                        return [createComponent(AppWorkspace.MainPane, { id: "list", label: "List", children: "List" }), "Reader"];
                      },
                    }),
                    createComponent(AppWorkspace.Detail, { id: "detail", open: true, width: "sm", children: "Detail" }),
                  ];
                },
              }),
            ];
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the compact sidebar fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, hash = "") => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem;--k2b-app-workspace-title:'Reports'"></div></body></html>`,
  );
  await page.evaluate((value) => {
    (window as unknown as { fixtureParams: string }).fixtureParams = value;
  }, hash);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__main-primary").waitFor({ state: "attached" });
  return page;
};

const read = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        display: style.display,
        visibility: style.visibility,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].join(" "),
      };
    };
    const toggle = document.querySelector<HTMLElement>("[data-app-workspace-sidebar-toggle]")!;
    return {
      bar: box(".k2b-app-workspace__compact-bar"),
      title: getComputedStyle(document.querySelector(".k2b-app-workspace__compact-title")!, "::before").content,
      sidebar: box(".k2b-app-workspace__sidebar"),
      pane: box(".k2b-app-workspace__main-pane"),
      detail: box(".k2b-app-workspace__detail"),
      label: toggle.getAttribute("aria-label"),
      expanded: toggle.getAttribute("aria-expanded"),
      focus: document.activeElement?.textContent?.trim() ?? "",
      rail:
        document.body.textContent?.includes("Rail icons") &&
        getComputedStyle(document.querySelector("[data-sidebar-mode='collapsed']")!).display !== "none",
    };
  });

describe("compact workspace sidebar", () => {
  test("at 820 px the bar names the page, the panes stay side by side, and the sidebar opens over them", async () => {
    const page = await load(820);
    try {
      const closed = await read(page);
      // The workspace's own 1 px frame surrounds the bar; the bar adds no line.
      expect(closed.bar).toMatchObject({ display: "flex", left: 1, top: 1, width: 818, borders: "0px 0px 0px 0px" });
      expect(closed.title).toBe('"Reports"');
      expect(closed.sidebar.visibility).toBe("hidden");
      expect(closed.pane.left).toBe(1);
      expect(closed.pane.top).toBe(47);
      expect(closed.detail.top).toBe(47);
      expect(closed).toMatchObject({ label: "Show navigation", expanded: "false" });

      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      const opened = await read(page);
      expect(opened.sidebar).toMatchObject({ visibility: "visible", left: 1, top: 1, width: 280, borders: "0px 0px 0px 0px" });
      expect(opened).toMatchObject({ expanded: "true", focus: "Reports" });
      expect(opened.pane).toEqual(closed.pane);

      await page.keyboard.press("Escape");
      expect(await read(page)).toMatchObject({ expanded: "false", focus: "" });
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-app-workspace-sidebar-toggle"))).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("a sidebar collapsed to its rail on a wide screen opens expanded in the overlay", async () => {
    const page = await load(820, "collapsed=1");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      const opened = await read(page);
      expect(opened.sidebar.width).toBe(280);
      expect(opened.rail).toBe(false);
      expect(await page.getByText("Projects").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("the button speaks the workspace's language", async () => {
    const page = await load(820, "locale=de");
    try {
      expect((await read(page)).label).toBe("Navigation anzeigen");
    } finally {
      await page.close();
    }
  });

  test("at 390 px and at 1180 px there is no bar", async () => {
    for (const width of [390, 1180]) {
      const page = await load(width);
      try {
        const shape = await read(page);
        expect(shape.bar.display).toBe("none");
        expect(shape.sidebar.display).toBe(width < 768 ? "none" : "flex");
        if (width >= 1024) expect(shape.sidebar.visibility).toBe("visible");
      } finally {
        await page.close();
      }
    }
  });
});
