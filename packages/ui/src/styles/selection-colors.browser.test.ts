import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const TEST_TIMEOUT = 20_000;
const entry = resolve(import.meta.dir, "selection-colors.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Button, Checkbox, createCollectionSelection, DataTable, FileGrid, FilterChip, FilterToggle, SegmentedControl, SettingsModal, Switch, Tabs, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
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

// Append after the geometry fixture; the parking spot at x=1400 stays outside.
const controls = document.createElement("section");
controls.id = "controls";
controls.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:12px;max-width:900px;flex:none";
document.getElementById("app")!.append(controls);
render(() => {
  const markdown = document.createElement("div");
  markdown.className = "k2b-content-markdown";
  markdown.innerHTML = '<a href="#x">Content link</a>';
  const probes = document.createElement("div");
  probes.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;pointer-events:none";
  for (const [name, declaration] of Object.entries({
    selected: "background:var(--k2b-selected)",
    solid: "background:var(--k2b-action-solid)",
    link: "color:var(--k2b-link-accent)",
    underline: "color:color-mix(in srgb, var(--k2b-link-accent) 55%, transparent)",
    action: "color:var(--k2b-action)",
    focus: "color:var(--k2b-focus-ring)",
  })) {
    const probe = document.createElement("span");
    probe.id = "probe-" + name;
    probe.style.cssText = "display:block;width:1px;height:1px;" + declaration;
    probes.append(probe);
  }
  return [
    createComponent(Tabs, {
      value: "one", onValueChange: () => {}, ariaLabel: "Selection tabs",
      options: [{ value: "one", label: "First tab" }, { value: "two", label: "Second tab" }],
    }),
    createComponent(ViewTabs, {
      label: "Views", current: "one",
      items: [{ id: "one", label: "First view", href: "#first-view" }, { id: "two", label: "Second view", href: "#second-view" }],
    }),
    createComponent(SegmentedControl, {
      value: "one", onValueChange: () => {}, ariaLabel: "Segments",
      options: [{ value: "one", label: "First segment" }, { value: "two", label: "Second segment" }],
    }),
    createComponent(FilterChip, {
      label: "Owner", icon: "ti ti-user", value: ["mine"], onValueChange: () => {},
      options: [{ options: [{ value: "mine", label: "Mine" }] }],
    }),
    createComponent(FilterToggle, { label: "Only mine", icon: "ti ti-user", active: true, onClick: () => {} }),
    createComponent(Button, { id: "primary-action", children: "Create" }),
    createComponent(Checkbox, { label: "Checked", value: true }),
    createComponent(Switch, { label: "On", value: true }),
    markdown,
    createComponent(Button, { id: "focus-action", variant: "secondary", children: "Focus action" }),
    probes,
  ];
}, controls);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection color fixture.");
const script = await build.outputs[0]!.text();

const apps = {
  Notebooks: {
    light: { ink: "#886805", row: "#fefaee", nav: "#fdf7e6" },
    dark: { ink: "#eab308", row: "#2f2b18", nav: "#363018" },
  },
  Mail: {
    light: { ink: "#0f766e", row: "#eef5f5", nav: "#e7f1f1" },
    dark: { ink: "#5ca29c", row: "#112327", nav: "#112529" },
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
      test(
        `${app} ${theme}: soft selections use host colors while actions, links, and focus keep platform colors`,
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
              <div id="scope" style="${hooks}"><div id="app"></div></div></body></html>`);
            await page.addScriptTag({ content: script });
            await page.mouse.move(1400, 1100);
            await settled(page);

            const selected = (await paint(page.locator("#probe-selected"))).background;
            for (const selector of [
              '.k2b-tabs__list button[aria-selected="true"]',
              '.k2b-view-tabs__tab[aria-current="page"]',
              '.k2b-segmented-control__option[data-selected="true"]',
              '.k2b-filter-chip[data-active="true"][aria-haspopup]',
              '.k2b-filter-chip[data-active="true"][aria-pressed="true"]',
            ]) {
              await settled(page);
              const actual = await paint(page.locator(`#controls ${selector}`));
              expect(actual.background, `${selector}: selection fill`).toEqual(colors ? rgb(colors.nav) : selected);
              expect(Number(actual.alpha), `${selector}: selection must have a painted background`).toBeGreaterThan(0);
              if (colors) expect(actual.ink, `${selector}: host ink`).toEqual(rgb(colors.ink));
              expect(contrast(actual.ink, actual.background), `${selector}: selected text contrast`).toBeGreaterThanOrEqual(4.5);
            }

            const independent = (actual: Rgb, label: string) => {
              if (colors)
                for (const [role, value] of Object.entries(colors))
                  expect(actual, `${label} must not use host ${role}`).not.toEqual(rgb(value));
            };
            await settled(page);
            const solid = (await paint(page.locator("#probe-solid"))).background;
            for (const selector of ["#primary-action", ".k2b-check__control", ".k2b-switch__track"]) {
              await settled(page);
              const actual = (await paint(page.locator(`#controls ${selector}`))).background;
              expect(actual, `${selector}: solid platform action`).toEqual(solid);
              independent(actual, selector);
            }

            // Normalize computed CSS colors through a canvas, including color(srgb)
            // from color-mix, preserving alpha when comparing the link underline.
            const computedColor = async (element: Locator, property: string) => {
              await settled(page);
              return element.evaluate((node, property) => {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 1;
                const context = canvas.getContext("2d")!;
                context.fillStyle = getComputedStyle(node).getPropertyValue(property);
                context.fillRect(0, 0, 1, 1);
                return Array.from(context.getImageData(0, 0, 1, 1).data);
              }, property);
            };
            const underline = await computedColor(page.locator("#controls .k2b-content-markdown a"), "text-decoration-color");
            expect(underline, "Content link underline must use the platform link accent at 55%").toEqual(
              await computedColor(page.locator("#probe-underline"), "color"),
            );
            const link = await computedColor(page.locator("#probe-link"), "color");
            expect(link, "Selection hooks must leave the default link accent equal to platform action").toEqual(
              await computedColor(page.locator("#probe-action"), "color"),
            );
            independent([underline[0]!, underline[1]!, underline[2]!], "Link underline");
            independent([link[0]!, link[1]!, link[2]!], "Link accent");

            await page.keyboard.press("Tab");
            const focused = page.locator("#focus-action");
            await focused.focus();
            await settled(page);
            expect(
              await focused.evaluate((node) => node.matches(":focus-visible")),
              "Secondary action must have keyboard-visible focus",
            ).toBe(true);
            const outline = await computedColor(focused, "outline-color");
            expect(outline, "Keyboard focus must keep the platform focus ring").toEqual(
              await computedColor(page.locator("#probe-focus"), "color"),
            );
            independent([outline[0]!, outline[1]!, outline[2]!], "Focus ring");
          } finally {
            await page.close();
          }
        },
        TEST_TIMEOUT,
      );
    }
  }
});
