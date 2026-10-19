import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const TEST_TIMEOUT = 20_000;
const entry = resolve(import.meta.dir, "selection-colors.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, createCollectionSelection, DataTable, FileGrid, SettingsModal } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => {
  const [active, setActive] = createSignal(false);
  const [category, setCategory] = createSignal("other");
  const rows = [{ id: "one", name: "Project notes" }, { id: "two", name: "Report" }];
  const selection = createCollectionSelection({ ids: () => rows.map(row => row.id) });
  const toggle = document.createElement("button");
  toggle.id = "toggle-selection";
  toggle.textContent = "Toggle selection";
  toggle.addEventListener("click", () => {
    const next = !active();
    setActive(next);
    setCategory(next ? "preferences" : "other");
    selection.replace(next ? ["one"] : []);
  });
  return [
    toggle,
    createComponent(AppWorkspace, {
      resizable: false, class: "selection-workspace",
      get children() { return [
        createComponent(AppWorkspace.Sidebar, {
          get children() { return createComponent(AppWorkspace.SidebarDesktop, {
            get children() { return createComponent(AppWorkspace.SidebarBody, {
              get children() { return (["row", "card", "object"] as const).map(variant =>
                createComponent(AppWorkspace.SidebarItem, {
                  variant, href: "#" + variant, get active() { return active(); }, description: "12 notes",
                  get children() { return [
                    createComponent(AppWorkspace.SidebarItemLabel, { children: "Project notes" }),
                    createComponent(AppWorkspace.SidebarItemMeta, { children: "3" }),
                  ]; },
                })
              ); },
            }); },
          }); },
        }),
        createComponent(AppWorkspace.Content, {
          get children() { return createComponent(AppWorkspace.Main, { children: "Workspace" }); },
        }),
      ]; },
    }),
    createComponent(DataTable<(typeof rows)[number]>, {
      rows, getRowId: row => row.id, get selectedRowId() { return active() ? "one" : null; },
      columns: [{ id: "name", header: "Name", value: "name" }],
    }),
    createComponent(FileGrid<(typeof rows)[number]>, {
      rows, getRowId: row => row.id, selection, label: "Files",
      renderPreview: () => "File", renderLabel: row => row.name, onOpen: () => {},
    }),
    createComponent(SettingsModal, {
      title: "Settings", get activeTab() { return category(); }, onTabChange: setCategory,
      get children() { return [
        createComponent(SettingsModal.Tab, { id: "preferences", title: "Preferences", children: "Preferences panel" }),
        createComponent(SettingsModal.Tab, { id: "other", title: "Other", children: "Other panel" }),
      ]; },
    }),
  ];
}, document.getElementById("app")!);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection color fixture.");
const script = await build.outputs[0]!.text();

const apps = {
  Notebooks: {
    light: { ink: "#836404", row: "#fefaee", nav: "#f3eedd" },
    dark: { ink: "#eab308", row: "#2f2b18", nav: "#423c24" },
  },
  Mail: {
    light: { ink: "#0f726b", row: "#eef5f5", nav: "#dde7e8" },
    dark: { ink: "#5ca29c", row: "#112327", nav: "#1d3236" },
  },
};

type Rgb = [number, number, number];
const rgb = (value: string): Rgb => {
  const channels = value
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16));
  return [channels[0]!, channels[1]!, channels[2]!];
};
// getComputedStyle serializes these colors as rgb()/rgba(). Alpha is composed
// over the painted surface, including translucent ancestor backgrounds.
const composite = (value: string, below: Rgb): Rgb => {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) throw new Error(`Expected rgb()/rgba(), got ${value}`);
  const alpha = channels[3] ?? 1;
  const channel = (index: number) => channels[index]! * alpha + below[index]! * (1 - alpha);
  return [channel(0), channel(1), channel(2)];
};
const contrast = (foreground: Rgb, background: Rgb) => {
  const luminance = (color: Rgb) => {
    const linear = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
};
const paint = async (element: Locator, textSelector?: string) => {
  const values = await element.evaluate((node, selector) => {
    const ancestors: string[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      ancestors.unshift(getComputedStyle(parent).backgroundColor);
    const text = selector ? node.querySelector(selector)! : node;
    return { background: getComputedStyle(node).backgroundColor, color: getComputedStyle(text).color, ancestors };
  }, textSelector);
  const surface = values.ancestors.reduce<Rgb>((below, value) => composite(value, below), [255, 255, 255]);
  const background = composite(values.background, surface);
  return { background, ink: composite(values.color, background), alpha: values.background.match(/[\d.]+/g)?.[3] ?? "1" };
};
const box = (element: Locator) =>
  element.evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  });

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("selection colors in the browser", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const app of ["Notebooks", "Mail", "standalone"] as const) {
      test(
        `${app} ${theme}: selection paint, contrast, hover, and geometry`,
        async () => {
          const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
          try {
            await page.route(`${assets}**`, (route) =>
              route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
            );
            const colors = app === "standalone" ? undefined : apps[app][theme];
            const hooks = colors
              ? `--k2b-app-workspace-active:${colors.ink};--k2b-app-workspace-selected:${colors.nav};--k2b-row-selected:${colors.row}`
              : "";
            await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style>
            <style>*,*::before,*::after{transition:none!important;animation:none!important}
            #app > .selection-workspace{height:200px;flex:none}
            #app{display:flex;flex-direction:column;gap:12px;padding:12px}#app > .k2b-settings{height:280px;flex:none}
            .k2b-app-workspace__sidebar{--k2b-workspace-sidebar-width:240px}</style></head>
            <body class="k2b-ui" data-theme="${theme}" style="margin:0">
            ${colors ? `<div id="scope" style="${hooks}">` : ""}<div id="app"></div>${colors ? "</div>" : ""}</body></html>`);
            await page.evaluate(() => Promise.all([400, 500, 600].map((weight) => document.fonts.load(`${weight} 14px 'IBM Plex Sans'`))));
            await page.addScriptTag({ content: script });
            await page.locator(".k2b-settings__tabs button").first().waitFor();
            await page.mouse.move(1400, 1100);
            const targets = [
              {
                element: page.locator('[href="#row"]'),
                kind: "nav",
                secondary: [".k2b-app-workspace__sidebar-item-description", ".k2b-app-workspace__sidebar-item-meta"],
              },
              {
                element: page.locator('[href="#card"]'),
                kind: "nav",
                secondary: [".k2b-app-workspace__sidebar-item-description", ".k2b-app-workspace__sidebar-item-meta"],
              },
              {
                element: page.locator('[href="#object"]'),
                kind: "nav",
                secondary: [".k2b-app-workspace__sidebar-item-description", ".k2b-app-workspace__sidebar-item-meta"],
              },
              { element: page.getByRole("tab", { name: "Preferences", exact: true }), kind: "nav" },
              { element: page.locator(".k2b-data-table__row").first(), kind: "row", text: "td" },
              { element: page.locator(".k2b-file-grid__item").first(), kind: "row", text: ".k2b-file-grid__name" },
            ] as const;
            const before = await Promise.all(
              targets.map(async (target) => ({
                box: await box(target.element),
                paint: await paint(target.element, "text" in target ? target.text : undefined),
              })),
            );
            // Toggle through the owning signal without moving the pointer over a tested row.
            const toggle = () => page.locator("#toggle-selection").dispatchEvent("click");
            await toggle();
            for (const [index, target] of targets.entries()) {
              const selected = await paint(target.element, "text" in target ? target.text : undefined);
              expect(await box(target.element), `${target.kind} geometry`).toEqual(before[index]!.box);
              expect(contrast(selected.ink, selected.background), `${target.kind} contrast`).toBeGreaterThanOrEqual(4.5);
              // Descriptions and counts on a navigation fill keep AA as well.
              if ("secondary" in target)
                for (const selector of target.secondary) {
                  const secondary = await paint(target.element, selector);
                  expect(contrast(secondary.ink, selected.background), `${selector} contrast`).toBeGreaterThanOrEqual(4.5);
                }
              if (colors) {
                expect(selected.background).toEqual(rgb(colors[target.kind]));
                if (target.kind === "nav") expect(selected.ink).toEqual(rgb(colors.ink));
              } else {
                expect(Number(selected.alpha)).toBeGreaterThan(0);
                expect(selected.background).not.toEqual(before[index]!.paint.background);
              }
            }
            for (const id of ["row", "card", "object"]) {
              const item = page.locator(`[href="#${id}"]`);
              const selected = await paint(item);
              const geometry = await box(item);
              await item.hover();
              expect((await paint(item)).background).toEqual(selected.background);
              expect(await box(item)).toEqual(geometry);
            }
            await page.mouse.move(1400, 1100);
            await toggle();
            for (const [index, target] of targets.entries()) {
              expect(await box(target.element)).toEqual(before[index]!.box);
              expect(await paint(target.element, "text" in target ? target.text : undefined)).toEqual(before[index]!.paint);
            }
          } finally {
            await page.close();
          }
        },
        TEST_TIMEOUT,
      );
    }
  }
});
