import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Scrollbar gutters and row bounds depend on real layout, which happy-dom
// does not model, so a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Hiding the scrollbar emulates an overlay scrollbar that takes no width.
const stylesheets = { track: css, overlay: css + ".k2b-app-workspace__sidebar-body{scrollbar-width:none!important}" };
type Mode = keyof typeof stylesheets;

const entry = resolve(import.meta.dir, "sidebar-inset.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const params = new URLSearchParams(window.fixtureParams ?? "");
const label = (children) => createComponent(AppWorkspace.SidebarItemLabel, { children });
const action = (label, visibility) => createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label, visibility });
const item = (props) => createComponent(AppWorkspace.SidebarItem, props);
const filler = (prefix, count) => Array.from({ length: count }, (_, i) => item({ href: "#" + prefix + i, children: prefix + " " + i }));
const tree = () => createComponent(AppWorkspace.NavTree, {
  ariaLabel: "Notes",
  defaultExpandedIds: ["book"],
  get children() {
    return createComponent(AppWorkspace.NavTree.Item, {
      id: "book", label: "Book",
      get children() {
        return [
          createComponent(AppWorkspace.NavTree.Item, { id: "a", label: "Note A", href: "#a" }),
          createComponent(AppWorkspace.NavTree.Item, { id: "b", label: "Note B", href: "#b" }),
        ];
      },
    });
  },
});

render(
  () => createComponent(AppWorkspace, {
    resizable: false,
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "navigation", label: "Navigation",
          mobile: params.has("stacked") ? "stacked" : undefined,
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  sidebarMode: "expanded",
                  get children() {
                    return [
                      createComponent(AppWorkspace.SidebarSection, {
                        title: "Recent",
                        get children() {
                          return [
                            item({ href: "#plain", children: "Plain row" }),
                            item({ href: "#active", active: true, children: "Active row" }),
                            item({ href: "#hover", preview: { label: "Details", content: "Chat details" },
                              children: [label("Hover action and preview"), action("Chat actions", "hover")] }),
                            item({ href: "#always", children: [label("Visible action"), action("Archive", "always")] }),
                            tree(),
                            ...filler("Recent", 11),
                          ];
                        },
                      }),
                      createComponent(AppWorkspace.SidebarSection, { title: "Earlier", get children() { return filler("Earlier", 15); } }),
                    ];
                  },
                });
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() { return createComponent(AppWorkspace.Main, { children: "Board" }); },
        }),
      ];
    },
  }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar inset fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Phones get the stacked sidebar, whose rows live in the sheet All opens; 1000 px gets the compact overlay.
const load = async (width: number, mode: Mode) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${stylesheets[mode]}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.evaluate(
    (value) => {
      (window as unknown as { fixtureParams: string }).fixtureParams = value;
    },
    width < 768 ? "stacked=1" : "",
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__sidebar-item").first().waitFor({ state: "attached" });
  if (width === 1000) await page.locator(".k2b-app-workspace__head-toggle").click();
  if (width < 768) {
    await page.locator(".k2b-app-workspace__sidebar-all").click();
    await page.locator(".k2b-app-workspace__sidebar-sheet").waitFor();
  }
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.mouse.move(width - 12, 780);
  return page;
};

const read = (page: Page) =>
  page.evaluate(() => {
    // A stacked sidebar's rows are in its sheet; their insets are measured against the sheet's list.
    const sheet = document.querySelector(".k2b-app-workspace__sidebar-sheet");
    const sidebar = (sheet ?? document.querySelector(".k2b-app-workspace__sidebar")!).getBoundingClientRect();
    const body = (sheet ?? document).querySelector(".k2b-app-workspace__sidebar-body[data-sidebar-mode='expanded']")!;
    const round = (value: number) => Math.round(value * 2) / 2;
    const rows = Array.from(body.querySelectorAll(".k2b-app-workspace__sidebar-item, .k2b-app-workspace__nav-tree-row"))
      .filter((element) => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility === "visible")
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          label: element.querySelector(".k2b-app-workspace__sidebar-item-label")?.textContent?.trim(),
          left: round(box.left - sidebar.left),
          right: round(sidebar.right - box.right),
          box: [box.x, box.y, box.width, box.height],
        };
      });
    return { rows, overflowing: body.scrollHeight > body.clientHeight };
  });

describe(`@k2b/ui sidebar inset (${browserName})`, () => {
  test.each([
    [1366, "track"],
    [1366, "overlay"],
    [1000, "track"],
    [1000, "overlay"],
    [390, "track"],
    [390, "overlay"],
  ] as const)("at %i px with the %s scrollbar, rows keep equal insets when actions appear", async (width, mode) => {
    const page = await load(width, mode);
    try {
      const rest = await read(page);
      // The sheet's list grows with its rows and the sheet scrolls instead.
      if (width >= 768) expect(rest.overflowing).toBe(true);
      expect(rest.rows).toHaveLength(33);
      const inset = width >= 768 ? 8 : 0;
      expect(rest.rows.filter(({ left, right }) => left !== inset || right !== inset)).toEqual([]);

      const scope = width < 768 ? page.locator(".k2b-app-workspace__sidebar-sheet") : page;
      const row = scope.locator(".k2b-app-workspace__sidebar-item", { has: page.getByText("Hover action and preview", { exact: true }) });
      const box = (await row.boundingBox())!;
      await page.mouse.move(box.x + 12, box.y + box.height / 2);
      const action = await row.getByRole("button", { name: "Chat actions", exact: true }).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          opacity: style.opacity,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          right: element.getBoundingClientRect().right,
          rowRight: element.closest(".k2b-app-workspace__sidebar-item")!.getBoundingClientRect().right,
        };
      });
      expect(action).toMatchObject({ opacity: "1", visibility: "visible" });
      expect(action.pointerEvents).not.toBe("none");
      expect(action.right).toBeLessThanOrEqual(action.rowRight);
      expect((await read(page)).rows).toEqual(rest.rows);
    } finally {
      await page.close();
    }
  });
});
