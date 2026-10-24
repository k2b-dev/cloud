import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Which navigation shows and how levels stand side by side are layout results of media queries, so a real engine runs
// the built package at the widths of a phone, an iPad in Split View, an iPad upright and across, and a monitor.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "mobile-shell-wide.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { AppWorkspace, MobileShell, TabBar, TextInput } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const levels = new URLSearchParams(location.search).get("levels");
const items = [
  { id: "start", label: "Start", title: "Example Cloud", icon: "ti ti-home", href: "/start" },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/tasks", current: true },
];
const rows = (count) => Array.from({ length: count }, (_, index) => {
  const row = document.createElement("p");
  row.className = "row";
  row.style.cssText = "margin:0;height:48px";
  row.textContent = "Task " + (index + 1);
  return row;
});
render(
  () =>
    createComponent(MobileShell, {
      scroll: levels === null && !new URLSearchParams(location.search).has("bottom"),
      get sidebar() {
        return createComponent(MobileShell.Sidebar, {
          label: "App",
          title: "Example Cloud",
          items: [{ ...items[0], title: "Start" }],
          sections: [{ title: "Apps", items: items.slice(1) }],
          footer: [{ id: "settings", label: "Settings", icon: "ti ti-settings", href: "/settings" }],
        });
      },
      get header() {
        return createComponent(MobileShell.Header, { title: "Tasks" });
      },
      get footer() {
        return createComponent(TabBar, { label: "App", items });
      },
      get children() {
        if (new URLSearchParams(location.search).has("bottom")) {
          const page = document.createElement("div");
          page.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0";
          const feed = document.createElement("div");
          feed.style.cssText = "flex:1";
          const composer = document.createElement("div");
          composer.setAttribute("data-k2b-shell-bottom", "");
          composer.style.cssText = "height:96px";
          page.append(feed, composer);
          return page;
        }
        if (levels === null) return rows(30);
        return createComponent(AppWorkspace, {
          flat: true,
          mobileSurface: "flush",
          resizable: false,
          get children() {
            return createComponent(AppWorkspace.Content, {
              get children() {
                return createComponent(AppWorkspace.Main, {
                  level: levels,
                  get children() {
                    return [
                      createComponent(AppWorkspace.MainPane, { id: "list", label: "Tasks", href: "?levels=list", defaultSize: 352, minSize: 352, maxSize: 352, get children() { return rows(20); } }),
                      createComponent(AppWorkspace.MainPane, {
                        id: "task",
                        label: "Order parts",
                        get children() {
                          return createComponent(TextInput, { id: "draft", label: "Comment", value: () => "", onValueChange: () => {} });
                        },
                      }),
                    ];
                  },
                });
              },
            });
          },
        });
      },
    }),
  document.getElementById("root"),
);
// A workspace outside the shell, as a portalled panel would be: the app's level rules must not reach it.
if (new URLSearchParams(location.search).has("sibling")) {
  const host = document.createElement("div");
  host.id = "sibling";
  host.style.cssText = "position:fixed;inset:0;z-index:5;background:white";
  document.body.append(host);
  render(
    () =>
      createComponent(AppWorkspace, {
        get children() {
          return createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, {
                level: "task",
                get children() {
                  return [
                    createComponent(AppWorkspace.MainPane, { id: "list", label: "Outside list", href: "?", get children() { return rows(3); } }),
                    createComponent(AppWorkspace.MainPane, { id: "task", label: "Outside task", get children() { return rows(1); } }),
                  ];
                },
              });
            },
          });
        },
      }),
    host,
  );
}
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the wide MobileShell fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, height: number, levels?: "list" | "task", sibling = false, bottom = false): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true });
  const page = await context.newPage();
  await page.route("https://app.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div><script>${script}</script></body></html>`,
    }),
  );
  await page.goto(`https://app.test/?${levels ? `levels=${levels}` : ""}${sibling ? "&sibling" : ""}${bottom ? "&bottom" : ""}`);
  await page.locator(".k2b-mobile-shell").waitFor();
  return page;
};

const frame = (page: Page) =>
  page.evaluate(() => {
    const shown = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return !!element && element.getClientRects().length > 0;
    };
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    return {
      sidebar: shown(".k2b-mobile-shell__sidebar") ? box(".k2b-mobile-shell__sidebar")!.width : 0,
      tabBar: shown(".k2b-tab-bar"),
      title: document.querySelector<HTMLElement>(".k2b-mobile-shell__title")?.innerText,
      sidebarHead: box(".k2b-mobile-shell__sidebar-head")?.height,
      header: box(".k2b-mobile-shell__header")?.height,
    };
  });

describe("MobileShell on wide screens", () => {
  // Split View 50/50 of an iPad Pro 13" across is 678 px wide; an iPad 11" upright is 834 px.
  for (const [width, height, sidebar] of [
    [390, 844, false],
    [678, 1024, false],
    [834, 1194, true],
    [1024, 1366, true],
    [1366, 1024, true],
    [2560, 1440, true],
  ] as const)
    test(`${width} × ${height}: ${sidebar ? "the sidebar" : "the tab bar"} leads to the pages`, async () => {
      const page = await open(width, height);
      try {
        const result = await frame(page);
        expect(result.tabBar).toBe(!sidebar);
        expect(result.sidebar).toBe(sidebar ? 240 : 0);
        if (sidebar) expect(result.sidebarHead).toBe(result.header);
      } finally {
        await page.context().close();
      }
    }, 30_000);
});

describe("AppWorkspace levels in a MobileShell", () => {
  const levels = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-workspace-level]")].map((level) => {
        const back = level.querySelector<HTMLElement>(".k2b-app-workspace__level-back");
        const box = level.getBoundingClientRect();
        return {
          shown: level.getClientRects().length > 0,
          width: Math.round(box.width),
          back: !!back && back.getClientRects().length > 0,
          raised: getComputedStyle(level).boxShadow !== "none",
          head: Math.round(level.querySelector(".k2b-app-workspace__level-head")!.getBoundingClientRect().height),
        };
      }),
    );

  test("below 64rem one level fills the page with its way back; from 64rem the list keeps 22rem beside the task", async () => {
    for (const [width, height, side] of [
      [390, 844, false],
      [678, 1024, false],
      [834, 1194, false],
      [1024, 1366, true],
      [1366, 1024, true],
      [2560, 1440, true],
    ] as const) {
      const page = await open(width, height, "task");
      try {
        const [list, task] = await levels(page);
        expect({ width, list: list!.shown, back: task!.back, raised: task!.raised }).toEqual({
          width,
          list: side,
          back: !side,
          raised: false,
        });
        if (side) expect(list!.width).toBe(352);
        // Each level's head is as high as the shell's header, so titles beside each other share one line.
        expect(task!.head).toBe(68);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  test("rotating and resizing keep the typed text and the focus in the same field", async () => {
    const page = await open(1024, 1366, "task");
    try {
      await page.locator("#draft").fill("Seals and filter");
      for (const [width, height] of [
        [1366, 1024],
        [678, 1024],
        [1024, 1366],
      ] as const) {
        await page.setViewportSize({ width, height });
        expect(await page.evaluate(() => [document.activeElement?.id, (document.activeElement as HTMLInputElement).value])).toEqual([
          "draft",
          "Seals and filter",
        ]);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a press on a tab shows the next page's frame without moving the tab under the finger", async () => {
    for (const [width, height, selector] of [
      [390, 844, '.k2b-tab-bar a[data-tab="start"]'],
      [1366, 1024, '.k2b-mobile-shell__sidebar a[data-tab="start"]'],
    ] as const) {
      const page = await open(width, height, "task");
      try {
        const result = await page.evaluate((selector) => {
          const link = document.querySelector<HTMLElement>(selector)!;
          const before = link.getBoundingClientRect().top;
          link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }));
          const shell = document.querySelector<HTMLElement>(".k2b-mobile-shell")!;
          return {
            switching: shell.hasAttribute("data-k2b-switching"),
            moved: link.getBoundingClientRect().top - before,
            header: getComputedStyle(document.querySelector(".k2b-mobile-shell__header")!).display,
            content: getComputedStyle(document.querySelector(".k2b-mobile-shell__main")!).visibility,
          };
        }, selector);
        expect(result).toEqual({ switching: true, moved: 0, header: "flex", content: "hidden" });
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("a workspace outside the shell keeps its own level rules", async () => {
    const page = await open(900, 1024, "task", true);
    try {
      const shown = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#sibling [data-workspace-level]")].map((level) => level.getClientRects().length > 0),
      );
      // Its own rule shows two levels from 48rem; the app's rule would leave one below 64rem.
      expect(shown).toEqual([true, true]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("content that owns the bottom edge, such as a composer, keeps toasts above itself", async () => {
    for (const [width, height] of [
      [390, 844],
      [1366, 1024],
    ] as const) {
      const page = await open(width, height, undefined, false, true);
      try {
        await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height") !== "");
        const footer = () =>
          page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height")));
        expect(await footer()).toBeGreaterThanOrEqual(96);
        // The composer grows with its text and shrinks again; the room above it follows.
        const resizeComposer = (height: string) =>
          page.evaluate((value) => {
            document.querySelector<HTMLElement>("[data-k2b-shell-bottom]")!.style.height = value;
          }, height);
        await resizeComposer("200px");
        await page.waitForFunction(
          () => Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height")) >= 200,
        );
        await resizeComposer("96px");
        await page.waitForFunction(
          () => Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height")) < 200,
        );
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);
});
