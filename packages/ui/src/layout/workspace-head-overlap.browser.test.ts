import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../test/browser";
import { headOverlaps } from "../../test/head-overlap";
import { workspaceCss, workspaceFrames } from "../../test/workspace-host-fixture";

// Error class: head controls overflow their row at intermediate widths and draw over each other. This sweep is its
// guard: heads shaped like the apps' (invented content) at every 8 px from 1920 to 600 and on a phone.
setDefaultTimeout(120_000);
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-head-overlap-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, LocaleProvider } = await import("../index");
const css = workspaceCss();

type Shape = {
  name: string;
  locale: "en" | "de";
  title: string;
  views: { label: string; count?: number }[];
  current: number;
  /** An add-view button beside the tabs, in the views slot, as a table app has it. */
  addView?: string;
  /** The app wraps its tabs in an element of its own, as Spaces does for its moved-views hint. */
  wrapViews?: boolean;
  chips: { label: string; value?: string }[];
  actions: { label: string; icon: string }[];
  primary: { label: string; icon: string };
  count?: string;
  /** An open detail of this width that waits behind Details where it does not fit. */
  detail?: "sm" | "md" | "lg";
};
const shapes: Shape[] = [
  {
    name: "Spaces",
    locale: "de",
    title: "Team Logistik",
    views: [{ label: "Liste" }, { label: "Tabelle" }, { label: "Kanban" }, { label: "Kalender" }],
    current: 2,
    wrapViews: true,
    chips: [{ label: "Tags", value: "Kunde" }, { label: "Zugewiesen" }],
    actions: [
      { label: "Suchen", icon: "ti ti-search" },
      { label: "Space-Menü", icon: "ti ti-dots" },
    ],
    primary: { label: "Neue Aufgabe", icon: "ti ti-plus" },
    count: "11 Aufgaben",
    detail: "md",
  },
  {
    name: "Mail Postfach",
    locale: "de",
    title: "Lager Nord",
    views: [
      { label: "Alle", count: 128 },
      { label: "Handlungsbedarf", count: 4 },
      { label: "Mir zugewiesen", count: 2 },
      { label: "Wartet auf Antwort" },
      { label: "Nicht zugewiesen" },
      { label: "Zurückgestellt" },
      { label: "Erledigt" },
    ],
    current: 0,
    chips: [{ label: "Tag", value: "Rechnung" }],
    actions: [{ label: "Postfach-Menü", icon: "ti ti-dots" }],
    primary: { label: "Verfassen", icon: "ti ti-pencil" },
    detail: "lg",
  },
  {
    name: "Contacts",
    locale: "en",
    title: "Suppliers",
    views: [
      { label: "All", count: 214 },
      { label: "Favorites", count: 12 },
    ],
    current: 0,
    chips: [{ label: "Tags", value: "Packaging" }, { label: "Company" }, { label: "City" }],
    actions: [],
    primary: { label: "New contact", icon: "ti ti-user-plus" },
    count: "38 contacts",
    detail: "md",
  },
  {
    name: "Grids",
    locale: "en",
    title: "Stock",
    views: [{ label: "All items" }, { label: "Low stock" }, { label: "By shelf" }],
    current: 1,
    addView: "New view",
    chips: [{ label: "Shelf", value: "B" }, { label: "Status" }, { label: "Supplier" }],
    actions: [{ label: "Table menu", icon: "ti ti-dots" }],
    primary: { label: "New row", icon: "ti ti-plus" },
    count: "42 rows",
  },
];

const icon = (name: string) => createComponent(Dynamic, { component: "i", class: name, "aria-hidden": "true" });
const tree = (shape: Shape): JSX.Element =>
  createComponent(LocaleProvider, {
    locale: shape.locale,
    get children() {
      return createComponent(PageTrailProvider, {
        trail: { title: shape.title, ancestors: [{ title: shape.name, href: "/app" }] },
        get children() {
          return createComponent(AppWorkspace, {
            get children() {
              const filtered = shape.chips.some((chip) => chip.value);
              return [
                createComponent(AppWorkspace.Head, {
                  get views() {
                    const tabs = createComponent(ViewTabs, {
                      label: "Views",
                      current: String(shape.current),
                      items: shape.views.map((view, index) => ({
                        id: String(index),
                        label: view.label,
                        href: `?view=${index}`,
                        count: view.count,
                      })),
                    });
                    if (shape.wrapViews) return createComponent(Dynamic, { component: "div", "data-app-views": "", children: tabs });
                    return shape.addView
                      ? [
                          tabs,
                          createComponent(IconButton, {
                            label: shape.addView,
                            size: "sm",
                            variant: "ghost",
                            get children() {
                              return icon("ti ti-plus");
                            },
                          }),
                        ]
                      : tabs;
                  },
                  get filters() {
                    return shape.chips.map((chip) =>
                      createComponent(FilterChip, {
                        showValue: true,
                        label: chip.label,
                        icon: "ti ti-filter",
                        value: chip.value ? [chip.value] : [],
                        onValueChange: () => {},
                        options: [{ multiple: true, options: [{ value: chip.value ?? "x", label: chip.value ?? "X" }] }],
                      }),
                    );
                  },
                  filtered,
                  resetHref: filtered ? "?" : undefined,
                  count: shape.count,
                  get actions() {
                    return shape.actions.map((action) =>
                      createComponent(IconButton, {
                        label: action.label,
                        size: "sm",
                        variant: "ghost",
                        get children() {
                          return icon(action.icon);
                        },
                      }),
                    );
                  },
                  primary: { ...shape.primary, href: "?new" },
                }),
                createComponent(AppWorkspace.Sidebar, {
                  id: "places",
                  label: "Places",
                  get children() {
                    return createComponent(AppWorkspace.SidebarDesktop, {
                      get children() {
                        return createComponent(AppWorkspace.SidebarBody, {
                          get children() {
                            return [shape.title, "Second place", "Third place"].map((label, index) =>
                              createComponent(AppWorkspace.SidebarItem, { href: `#${index}`, active: index === 0, children: label }),
                            );
                          },
                        });
                      },
                    });
                  },
                }),
                createComponent(AppWorkspace.Content, {
                  get children() {
                    return [
                      createComponent(AppWorkspace.Main, {
                        get children() {
                          return Array.from({ length: 20 }, (_, index) =>
                            createComponent(Dynamic, { component: "p", style: "min-height:44px", children: `Row ${index + 1}` }),
                          );
                        },
                      }),
                      shape.detail
                        ? createComponent(AppWorkspace.Detail, {
                            id: "detail",
                            width: shape.detail,
                            open: true,
                            onClose: () => {},
                            children: "Detail",
                          })
                        : null,
                    ];
                  },
                }),
              ];
            },
          });
        },
      });
    },
  });

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (shape: Shape, viewport: number) => {
  const phone = viewport < 768;
  const page = await browser.newPage({ viewport: { width: viewport, height: 900 }, isMobile: phone, reducedMotion: "reduce" });
  const markup = renderToString(() => tree(shape));
  await page.setContent(
    `<!doctype html><html lang="${shape.locale}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
    <body class="k2b-ui" style="margin:0"><div id="app" style="container:k2b-app-area / inline-size;width:${viewport}px;height:900px;display:flex;flex-direction:column">${markup}</div></body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await workspaceFrames(page);
  return page;
};
const widths = Array.from({ length: (1920 - 600) / 8 + 1 }, (_, index) => 1920 - index * 8);
declare global {
  interface Window {
    headOverlaps: typeof headOverlaps;
  }
}
/** Narrows the host step by step inside the page, two frames per step, and lists every problem by width. */
const sweepHost = (page: Page, steps: number[], label: string) =>
  page.evaluate(
    async ({ steps, label }) => {
      const host = document.getElementById("app")!;
      const problems: string[] = [];
      for (const width of steps) {
        host.style.width = `${width}px`;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const result = window.headOverlaps();
        if (!result.head) problems.push(`${label} ${width}: no head`);
        for (const problem of result.problems) problems.push(`${label} ${width}: ${problem}`);
      }
      return problems;
    },
    { steps, label },
  );

for (const shape of shapes) {
  // The host narrows inside a wide window (Cloud's panel open beside the app), and the window itself narrows.
  test(`${browserName}: ${shape.name} head controls never overlap or leave the head from 1920 to 600 px and at 390 px`, async () => {
    const problems: string[] = [];
    const page = await load(shape, 1920);
    try {
      await page.addScriptTag({ content: `window.headOverlaps = ${headOverlaps.toString()};` });
      problems.push(...(await sweepHost(page, widths, "host in a 1920 window")));
      for (const width of [...widths, 390]) {
        await page.setViewportSize({ width, height: 900 });
        problems.push(...(await sweepHost(page, [width], "window")));
      }
    } finally {
      await page.close();
    }
    expect(problems.slice(0, 40)).toEqual([]);
  });
}

test(`${browserName}: the overlap guard rejects partially and fully clipped actions`, async () => {
  const page = await load(shapes[0]!, 1440);
  try {
    await page.locator(".k2b-app-workspace__head-actions").evaluate((element) => {
      element.style.width = "10px";
      element.style.maxWidth = "10px";
      element.style.overflow = "hidden";
      element.style.flexWrap = "nowrap";
    });
    const result = await page.evaluate(headOverlaps);
    expect(result.problems.some((problem) => problem.startsWith("action") && problem.endsWith("is clipped"))).toBe(true);
    expect(result.problems.some((problem) => problem.startsWith("primary") && problem.endsWith("is clipped"))).toBe(true);
  } finally {
    await page.close();
  }
});
