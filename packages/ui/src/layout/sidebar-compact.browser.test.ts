import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Between 48 and 64 rem the sidebar is an overlay that a button in the
// workspace's head opens. Which regions show, what covers what, and where focus goes depend
// on real layout and a real focus model, so a real engine runs the shipped
// browser build of a hydrated workspace, which installs its own controller.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-compact.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, LocaleProvider, PageTrailProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const params = new URLSearchParams(window.fixtureParams ?? "");
const [hidden, setHidden] = createSignal(false);
window.hideNavigation = () => setHidden(true);
window.chosen = [];
const item = (label, active) =>
  createComponent(AppWorkspace.SidebarItem, { href: "#" + label.toLowerCase(), active, children: label });
const node = (props) => createComponent(AppWorkspace.NavTree.Item, props);
// A tree like Notebooks': a folder that only expands, a note chosen by a button, and a linked note.
const tree = () =>
  createComponent(AppWorkspace.NavTree, {
    ariaLabel: "Notes",
    selectedId: "b",
    defaultExpandedIds: ["book"],
    get children() {
      return node({
        id: "book",
        label: "Book",
        get children() {
          return [node({ id: "a", label: "Note A", onSelect: () => window.chosen.push("a") }), node({ id: "b", label: "Note B", href: "#b" })];
        },
      });
    },
  });
// A row whose own button opens its preview, like the recent files in Files.
const previewRow = () =>
  createComponent(AppWorkspace.SidebarItem, { preview: { label: "Recent", trigger: "row", content: "Recent files" }, children: "Recent" });
const sidebar = (id) =>
  createComponent(AppWorkspace.Sidebar, {
    id,
    label: "Navigation",
    collapsible: true,
    mobile: params.has("stacked") ? "stacked" : undefined,
    get hidden() {
      return hidden();
    },
    get children() {
      return createComponent(AppWorkspace.SidebarDesktop, {
        get children() {
          return [
            createComponent(AppWorkspace.SidebarBody, {
              sidebarMode: "expanded",
              get children() {
                return [
                  item("Projects", false),
                  item("Reports", !params.has("tree")),
                  params.has("preview") ? previewRow() : item("Archive", false),
                  params.has("tree") ? tree() : null,
                ];
              },
            }),
            createComponent(AppWorkspace.SidebarBody, { sidebarMode: "collapsed", children: "Rail icons" }),
          ];
        },
      });
    },
  });
const persisted = Number(params.get("detail")) || undefined;
const workspace = (prefix, detail) =>
  createComponent(AppWorkspace, {
    layoutState: () =>
      params.get("collapsed")
        ? { version: 2, sidebarCollapsed: true }
        : persisted
          ? { version: 2, detailWidths: { detail: persisted } }
          : null,
    get children() {
      return [
        sidebar(prefix + "navigation"),
        createComponent(AppWorkspace.Content, {
          get children() {
            return [
              createComponent(AppWorkspace.Main, {
                get children() {
                  return [createComponent(AppWorkspace.MainPane, { id: prefix + "list", label: "List", children: "List" }), "Reader"];
                },
              }),
              createComponent(AppWorkspace.Detail, { id: prefix + "detail", open: true, width: "sm", children: detail }),
            ];
          },
        }),
      ];
    },
  });

render(
  () =>
    createComponent(LocaleProvider, {
      locale: params.get("locale") ?? "en",
      get children() {
        // The host names the page; a nested workspace hydrates with its own controller, as it does outside Cloud.
        return createComponent(PageTrailProvider, {
          trail: { title: "Reports", ancestors: [] },
          get children() {
            return workspace("", params.has("nested") ? workspace("inner-", "Inner") : "Detail");
          },
        });
      },
    }),
  document.getElementById("app"),
);
// The width the stylesheet gives the detail before the controller's first frame.
window.detailAtRender = Math.round(document.querySelector(".k2b-app-workspace__detail").getBoundingClientRect().width);
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
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.evaluate((value) => {
    (window as unknown as { fixtureParams: string }).fixtureParams = value;
  }, hash);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__main-primary").first().waitFor({ state: "attached" });
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
    const toggle = document.querySelector<HTMLElement>("[data-app-workspace-sidebar-toggle]");
    const title = document.querySelector(".k2b-app-workspace__head .k2b-page-title__text");
    return {
      bar: box(".k2b-app-workspace__head"),
      title: title?.textContent ?? null,
      sidebar: box(".k2b-app-workspace__sidebar"),
      pane: box(".k2b-app-workspace__main-pane"),
      detail: box(".k2b-app-workspace__detail"),
      label: toggle?.getAttribute("aria-label") ?? null,
      expanded: toggle?.getAttribute("aria-expanded") ?? null,
      focus: document.activeElement?.textContent?.trim() ?? "",
      rail:
        document.body.textContent?.includes("Rail icons") &&
        getComputedStyle(document.querySelector("[data-sidebar-mode='collapsed']")!).display !== "none",
    };
  });

// The controller reconciles sizes in an animation frame after it attaches.
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const overlay = (page: Page, sidebar = "navigation") =>
  page.evaluate((id) => {
    const toggle = document.querySelector<HTMLElement>(`[data-app-workspace-sidebar-toggle][aria-controls="${id}"]`);
    const root = document.getElementById(id)!.closest<HTMLElement>("[data-k2b-app-workspace]")!;
    return {
      expanded: toggle?.getAttribute("aria-expanded") ?? null,
      open: root.dataset.sidebarOverlay === "open",
      inert: Array.from(root.querySelectorAll("[inert]")).length,
    };
  }, sidebar);
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      inSidebar: Boolean(active && document.getElementById("navigation")?.contains(active)),
      role: active?.getAttribute("role") ?? active?.localName ?? "",
      tree: active?.dataset.k2bNavTreeId ?? null,
      text: active?.textContent?.trim() ?? "",
    };
  });

describe("compact workspace sidebar", () => {
  test("at 820 px the head names the page, the panes stay side by side, and the sidebar opens over them", async () => {
    const page = await load(820);
    try {
      const closed = await read(page);
      // The workspace's own 1 px frame surrounds the head; the head adds no line.
      expect(closed.bar).toMatchObject({ display: "flex", left: 1, top: 1, width: 818, borders: "0px 0px 0px 0px" });
      expect(closed.title).toBe("Reports");
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

  test("at 390 px and at 1180 px a page with nothing above it has no head", async () => {
    for (const width of [390, 1180]) {
      const page = await load(width);
      try {
        const shape = await read(page);
        expect(shape.bar?.display).toBe("none");
        expect(shape.sidebar.display).toBe(width < 768 ? "none" : "flex");
        if (width >= 1024) expect(shape.sidebar.visibility).toBe("visible");
      } finally {
        await page.close();
      }
    }
  });
  test("with a tree in the sidebar, focus starts on the tree's tab stop and Tab stays in the overlay", async () => {
    const page = await load(820, "tree=1");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      // The selected note's tree item is the tree's one tab stop; the link in its row is not.
      expect(await focused(page)).toMatchObject({ inSidebar: true, role: "treeitem", tree: "b" });
      await page.keyboard.press("ArrowUp");
      expect(await focused(page)).toMatchObject({ role: "treeitem", tree: "a" });
      for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        expect({ key, ...(await focused(page)) }).toMatchObject({ key, inSidebar: true });
      }
      expect(await overlay(page)).toMatchObject({ expanded: "true", open: true });
    } finally {
      await page.close();
    }
  });

  test("a folder that only expands keeps the overlay open, and a note inside an expanded folder closes it", async () => {
    const page = await load(820, "tree=1");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      await page.getByRole("treeitem", { name: "Book" }).locator("> .k2b-app-workspace__sidebar-item").click();
      expect(await overlay(page)).toMatchObject({ open: true });
      await page.getByRole("treeitem", { name: "Book" }).locator("> .k2b-app-workspace__sidebar-item").click();
      expect(await page.getByText("Note A").count()).toBe(1);
      await page.getByText("Note A").click();
      expect(await page.evaluate(() => (window as unknown as { chosen: string[] }).chosen)).toEqual(["a"]);
      expect(await overlay(page)).toEqual({ expanded: "false", open: false, inert: 0 });
    } finally {
      await page.close();
    }
  });

  test("a row that opens its preview keeps the overlay open", async () => {
    const page = await load(820, "preview=1");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      await page.locator(".k2b-app-workspace__sidebar-item-main", { hasText: "Recent" }).click();
      expect(await overlay(page)).toMatchObject({ expanded: "true", open: true });
      expect(await page.getByText("Recent files").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  // The detail may take what the main region's 320 px leave; a sidebar takes its share only in its own column.
  const detailSizes = (page: Page) =>
    page.evaluate(() => {
      const width = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width;
      return {
        atRender: (window as unknown as { detailAtRender: number }).detailAtRender,
        attached: Math.round(width(".k2b-app-workspace__detail")),
        max: Number(document.querySelector("[data-app-workspace-resize='detail']")!.getAttribute("aria-valuemax")),
        room: Math.round(width(".k2b-app-workspace") - 320),
        sidebar: Math.round(width(".k2b-app-workspace__sidebar")),
      };
    });

  test("a persisted detail width stays as the stylesheet drew it, beside an overlay sidebar or a sidebar column", async () => {
    for (const width of [820, 1100]) {
      const page = await load(width, "detail=400");
      try {
        await settle(page);
        const detail = await detailSizes(page);
        expect({ width, atRender: detail.atRender, attached: detail.attached }).toEqual({ width, atRender: 400, attached: 400 });
        expect(detail.max).toBe(Math.min(640, width < 1024 ? detail.room : detail.room - detail.sidebar));
      } finally {
        await page.close();
      }
    }
  });

  test("at 820 px a stacked sidebar stays above the content, with no bar and no share of the detail's width", async () => {
    const page = await load(820, "stacked=1&detail=400");
    try {
      await settle(page);
      const shape = await read(page);
      expect(shape.bar.display).toBe("none");
      expect(shape.sidebar).toMatchObject({ display: "flex", visibility: "visible", left: 1, top: 1, width: 818 });
      expect(shape.pane.top).toBeGreaterThan(shape.sidebar.top);
      expect(await page.getByText("Projects").isVisible()).toBe(true);
      const detail = await detailSizes(page);
      expect(detail).toMatchObject({ atRender: 400, attached: 400, max: Math.min(640, detail.room) });
    } finally {
      await page.close();
    }
  });

  test("hiding the navigation while the overlay is open closes the overlay", async () => {
    const page = await load(820);
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      await page.evaluate(() => (window as unknown as { hideNavigation: () => void }).hideNavigation());
      await settle(page);
      expect(await overlay(page)).toEqual({ expanded: "false", open: false, inert: 0 });
      // Without navigation the head has no button to show.
      expect(await page.locator("[data-app-workspace-sidebar-toggle]").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("Escape closes the overlay after a click left focus on nothing inside it", async () => {
    const page = await load(820);
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      expect(await overlay(page)).toMatchObject({ expanded: "false", open: false });
    } finally {
      await page.close();
    }
  });

  test("closing the overlay leaves a region the application made inert inert", async () => {
    const page = await load(820);
    try {
      await page.evaluate(() => document.querySelector(".k2b-app-workspace__content")!.setAttribute("inert", ""));
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => document.querySelector(".k2b-app-workspace__content")!.hasAttribute("inert"))).toBe(true);
      expect(await overlay(page)).toEqual({ expanded: "false", open: false, inert: 1 });
    } finally {
      await page.close();
    }
  });

  test("a nested workspace's button opens its own overlay every time", async () => {
    const page = await load(820, "nested=1");
    try {
      const toggle = page.locator("[data-app-workspace-sidebar-toggle][aria-controls='inner-navigation']");
      for (let round = 0; round < 2; round++) {
        await toggle.click();
        expect(await overlay(page, "inner-navigation")).toMatchObject({ expanded: "true", open: true });
        expect(await overlay(page)).toMatchObject({ expanded: "false", open: false });
        await page.keyboard.press("Escape");
        expect(await overlay(page, "inner-navigation")).toMatchObject({ expanded: "false", open: false });
      }
    } finally {
      await page.close();
    }
  });
});
