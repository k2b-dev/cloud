import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// The type scale grows inside fixed boxes: every primitive below keeps the
// height it had before the larger, heavier type (#1405), so a page set in the
// new scale lays out exactly as before. The baseline heights come from main.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// The shipped faces, so text metrics are the same in Chromium and WebKit.
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const TEST_TIMEOUT = 20_000;
const entry = resolve(import.meta.dir, "type-scale.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Button, DataTable, PanelHeader, StatusBadge, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const label = (children) => createComponent(AppWorkspace.SidebarItemLabel, { children });
const button = (size) => createComponent(Button, { size, variant: "secondary", "data-probe": "button-" + size, children: "Save changes" });
render(() => createComponent(AppWorkspace, {
  resizable: false,
  get children() { return [
    createComponent(AppWorkspace.Sidebar, {
      get children() { return createComponent(AppWorkspace.SidebarDesktop, {
        get children() { return createComponent(AppWorkspace.SidebarBody, {
          get children() { return createComponent(AppWorkspace.SidebarSection, {
            title: "Folders",
            get children() { return [
              createComponent(AppWorkspace.SidebarItem, { href: "#inbox", get meta() { return createComponent(AppWorkspace.SidebarItemStatus, { unread: 4 }); }, children: label("Inbox") }),
              createComponent(AppWorkspace.SidebarItem, { href: "#sent", children: label("Sent") }),
              createComponent(AppWorkspace.SidebarItem, { href: "#card", variant: "card", description: "Updated today", children: label("Quarterly plan") }),
            ]; },
          }); },
        }); },
      }); },
    }),
    createComponent(AppWorkspace.Content, {
      get children() { return createComponent(AppWorkspace.Main, {
        get children() {
          const box = document.createElement("div");
          box.style.cssText = "display:grid;gap:12px;padding:16px;justify-items:start";
          render(() => [
            createComponent(PanelHeader, { title: "Team settings", size: "md" }),
            ...["xs", "sm", "md", "lg"].map(button),
            createComponent(TextInput, { label: "Display name", description: "Shown to people you share with.", value: "Ada" }),
            createComponent(StatusBadge, { tone: "ok", label: "Active" }),
            createComponent(DataTable, {
              ariaLabel: "Files",
              rows: [{ id: "a", name: "Report.pdf", size: "2 MB" }],
              columns: [{ id: "name", header: "Name", value: "name" }, { id: "size", header: "Size", value: "size" }],
            }),
          ], box);
          return box;
        },
      }); },
    }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the type scale fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Cloud pages run under Tailwind's preflight, whose 1.5 body line height is
// where a larger font would grow a box that sets no line height of its own.
const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="en" style="line-height:1.5"><head><style>${css}</style><style>${fonts}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      '<body class="k2b-ui" data-theme="light" style="margin:0"><div id="app" style="height:48rem"></div></body></html>',
  );
  await page.evaluate(() =>
    Promise.all(["400 13px 'IBM Plex Sans'", "500 13px 'IBM Plex Sans'", "600 13px 'IBM Plex Sans'"].map((font) => document.fonts.load(font))),
  );
  await page.addScriptTag({ content: script });
  await page.locator('[data-probe="button-md"]').waitFor();
  return page;
};

const probes = {
  sidebarItem: '[href="#sent"]',
  sidebarSection: ".k2b-app-workspace__sidebar-section-header > h2",
  sidebarCount: ".k2b-app-workspace__sidebar-status-count",
  sidebarDescription: '[href="#card"] .k2b-app-workspace__sidebar-item-description',
  buttonXs: '[data-probe="button-xs"]',
  buttonSm: '[data-probe="button-sm"]',
  buttonMd: '[data-probe="button-md"]',
  buttonLg: '[data-probe="button-lg"]',
  fieldLabel: ".k2b-field__label",
  fieldDescription: ".k2b-field__description",
  field: ".k2b-field",
  input: ".k2b-field input",
  badge: ".k2b-status-badge",
  tableHeader: ".k2b-data-table th",
  tableRow: ".k2b-data-table tbody tr",
  title: ".k2b-panel-header__title",
} as const;

type Probe = { height: number; fontSize: string; fontWeight: string; lineHeight: string; color: string; letterSpacing: string };

const measure = (page: Page) =>
  page.evaluate((selectors) => {
    const out: Record<string, Probe> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${name}: ${selector}`);
      const style = getComputedStyle(element);
      out[name] = {
        height: element.getBoundingClientRect().height,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
        letterSpacing: style.letterSpacing,
      };
    }
    return out;
  }, probes) as Promise<Record<keyof typeof probes, Probe>>;

// Heights on main before the larger type, the same in Chromium and WebKit.
// The table splits its 64px between header and row by half a pixel
// differently per engine, so the two count together.
const baseline = {
  sidebarItem: 32,
  sidebarSection: 16,
  sidebarCount: 16,
  sidebarDescription: 18,
  buttonXs: 24,
  buttonSm: 28,
  buttonMd: 32,
  buttonLg: 40,
  fieldLabel: 18,
  fieldDescription: 15.39,
  field: 81.39,
  input: 32,
  badge: 20,
  title: 24,
} as const;

// The C Kontrast scale: [font size, weight, color] per primitive.
const ink = { text: "rgb(9, 9, 11)", secondary: "rgb(39, 39, 42)" };
const scale = {
  sidebarItem: ["13px", "400", ink.text],
  sidebarSection: ["12px", "600", ink.secondary],
  sidebarCount: ["11px", "600", ink.text],
  sidebarDescription: ["13px", "400", ink.secondary],
  buttonXs: ["12px", "600", ink.secondary],
  buttonSm: ["12px", "600", ink.secondary],
  buttonMd: ["13px", "600", ink.secondary],
  buttonLg: ["14px", "600", ink.secondary],
  fieldLabel: ["13px", "600", ink.secondary],
  fieldDescription: ["12px", "400", ink.secondary],
  badge: ["10px", "600", "rgb(4, 120, 87)"],
  tableHeader: ["12px", "700", ink.text],
} as const;

describe(`type scale in ${browserName}`, () => {
  test(
    "the larger, heavier type keeps every primitive at its former height",
    async () => {
      const page = await load();
      try {
        const probe = await measure(page);
        const heights = Object.fromEntries(Object.keys(baseline).map((name) => [name, probe[name as keyof typeof baseline].height]));
        // A sixty-fourth of a pixel is how the engines round a line box, not a shift.
        for (const [name, height] of Object.entries(baseline)) expect({ name, height: heights[name]! }).toEqual({ name, height: expect.closeTo(height, 1) });
        expect(probe.tableHeader.height + probe.tableRow.height).toBe(64);

        const type = Object.fromEntries(
          Object.keys(scale).map((name) => {
            const { fontSize, fontWeight, color } = probe[name as keyof typeof scale];
            return [name, [fontSize, fontWeight, color]];
          }),
        );
        expect(type).toEqual(scale);
        // Two-line sidebar labels keep their height too, whatever the host's line height.
        expect(probe.sidebarItem.lineHeight).toBe("18px");
        expect(probe.title.letterSpacing).toBe(`${-0.018 * 16}px`);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
