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
import { AppWorkspace, Button, DataTable, DetailPanel, FactGroup, Kbd, NoticeCard, PanelHeader, Section, StatusBadge, Tag, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const label = (children) => createComponent(AppWorkspace.SidebarItemLabel, { children });
const button = (size, probe = "button-" + size) => createComponent(Button, { size, variant: "secondary", "data-probe": probe, children: "Save changes" });
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
            ...["xs", "sm", "md", "lg"].map((size) => button(size)),
            createComponent(TextInput, { label: "Display name", description: "Shown to people you share with.", value: "Ada" }),
            createComponent(StatusBadge, { tone: "ok", label: "Active" }),
            createComponent(StatusBadge, { tone: "warning", label: "Waiting", variant: "chip" }),
            createComponent(Tag, { color: "#2563eb", children: "Customer" }),
            createComponent(Tag, { size: "sm", children: "Draft" }),
            createComponent(Kbd, { keys: "Mod+K" }),
            createComponent(DetailPanel, {
              get children() { return [
                createComponent(DetailPanel.Header, { title: "Follow up the offer", kind: "Task", subtitle: "Sales · due tomorrow" }),
                createComponent(DetailPanel.Body, {
                  get children() { return [
                    createComponent(FactGroup, { title: "Details", items: [{ label: "Owner", value: "Jonas Weil" }, { label: "Customer", value: "Hofmann GmbH" }] }),
                    createComponent(Section, { title: "Notes", children: "Confirm the price for 40 pallets." }),
                  ]; },
                }),
              ]; },
            }),
            createComponent(NoticeCard, { tone: "warning", title: "Settings cannot be read", get children() { return [button("sm", "notice-sm"), button("xs", "notice-xs")]; } }),
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
    Promise.all(
      ["400 13px 'IBM Plex Sans'", "500 13px 'IBM Plex Sans'", "600 13px 'IBM Plex Sans'"].map((font) => document.fonts.load(font)),
    ),
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
  noticeButtonSm: '[data-probe="notice-sm"]',
  noticeButtonXs: '[data-probe="notice-xs"]',
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
// The table counts header and row together, as engines once split a shared
// line between them differently.
const baseline = {
  sidebarItem: 32,
  sidebarSection: 16,
  sidebarCount: 16,
  sidebarDescription: 20,
  buttonXs: 24,
  buttonSm: 28,
  buttonMd: 32,
  buttonLg: 40,
  // K1: a button in an alert cell keeps its own height (28 px small, 24 px extra small).
  noticeButtonSm: 28,
  noticeButtonXs: 24,
  // K5: a 20 px label row, the 36 px control, a 16 px help line, 4 px apart.
  fieldLabel: 20,
  fieldDescription: 16,
  field: 80,
  input: 32,
  badge: 20,
  // K11: the head title is the body role, 14/20.
  title: 20,
} as const;

// The C Kontrast scale: [font size, weight, color] per primitive.
const ink = { text: "rgb(9, 9, 11)", secondary: "rgb(39, 39, 42)", muted: "rgb(69, 69, 78)", subtle: "rgb(113, 113, 122)" };
const scale = {
  sidebarItem: ["13px", "400", ink.text],
  sidebarSection: ["12px", "600", ink.secondary],
  sidebarCount: ["12px", "600", ink.text],
  sidebarDescription: ["13px", "400", ink.secondary],
  // Secondary buttons carry body ink on their white face.
  buttonXs: ["12px", "600", ink.text],
  buttonSm: ["12px", "600", ink.text],
  buttonMd: ["13px", "600", ink.text],
  buttonLg: ["14px", "600", ink.text],
  // K11: labels and help in the 12 px meta size; help in the quiet third grey.
  fieldLabel: ["12px", "500", ink.secondary],
  fieldDescription: ["12px", "400", ink.subtle],
  // K11: a state chip is meta 12/500, as in the mockup.
  badge: ["12px", "500", "rgb(4, 120, 87)"],
  // K7: the table head is 12 px grey words without a fill.
  tableHeader: ["12px", "500", ink.subtle],
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
        for (const [name, height] of Object.entries(baseline))
          expect({ name, height: heights[name]! }).toEqual({ name, height: expect.closeTo(height, 1) });
        // The table: a 36px head above 40px rows (K1; data-table-lines.browser.test.ts owns the rest).
        expect(probe.tableHeader.height + probe.tableRow.height).toBe(76);

        const type: Record<string, readonly string[]> = Object.fromEntries(
          Object.keys(scale).map((name) => {
            const { fontSize, fontWeight, color } = probe[name as keyof typeof scale];
            return [name, [fontSize, fontWeight, color]];
          }),
        );
        expect(type).toEqual(scale);
        // K11: sidebar labels are the row role, 13/20, whatever the host's line height.
        expect(probe.sidebarItem.lineHeight).toBe("20px");
        expect(probe.title.letterSpacing).toBe(`${-0.018 * 14}px`);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  // Cloud flach (K11): four sizes in the controls, as tokens a building block sets instead of choosing a size.
  test(
    "the four control sizes are 12, 13, 14, and 18 px",
    async () => {
      const page = await load();
      try {
        const sizes = await page.evaluate(() =>
          Object.fromEntries(
            ["meta", "row", "body", "lead"].map((step) => {
              const probe = document.createElement("span");
              probe.style.fontSize = `var(--k2b-font-size-${step})`;
              document.getElementById("app")!.append(probe);
              const size = getComputedStyle(probe).fontSize;
              probe.remove();
              return [step, size];
            }),
          ),
        );
        expect(sizes).toEqual({ meta: "12px", row: "13px", body: "14px", lead: "18px" });
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  // K11: a rendered flat sample — shell, list, detail, badges, tags — shows the four type roles and nothing else.
  test(
    "a flat sample shows only the four type roles and weights 400 to 600",
    async () => {
      const page = await load();
      try {
        const tokens = await page.evaluate(() =>
          ["meta", "row", "body", "lead"].map((role) => {
            const probe = document.createElement("span");
            probe.style.cssText = `font-size:var(--k2b-font-size-${role});line-height:var(--k2b-line-height-${role});font-weight:var(--k2b-font-weight-${role})`;
            document.getElementById("app")!.append(probe);
            const style = getComputedStyle(probe);
            const out = `${role} ${style.fontSize}/${style.lineHeight} ${style.fontWeight}`;
            probe.remove();
            return out;
          }),
        );
        expect(tokens).toEqual(["meta 12px/16px 400", "row 13px/20px 400", "body 14px/20px 400", "lead 18px/24px 600"]);

        const styles = await page.evaluate(() => {
          const found: Record<string, string> = {};
          const walker = document.createTreeWalker(document.getElementById("app")!, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent?.trim();
            const element = node.parentElement;
            if (!text || !element || element.closest("[aria-hidden='true'], .k2b-sr-only, .k2b-avatar")) continue;
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (style.visibility !== "visible" || box.width <= 1 || box.height <= 1) continue;
            found[`${style.fontSize}/${style.fontWeight}`] ??= text.slice(0, 32);
          }
          return found;
        });
        const off = Object.entries(styles).filter(([style]) => {
          const [size, weight] = style.split("/");
          return !["12px", "13px", "14px", "18px"].includes(size!) || !["400", "500", "600"].includes(weight!);
        });
        expect(off).toEqual([]);
        // The sample really covers the roles it claims: meta, row, and body text are all on the page.
        const sizes = new Set(Object.keys(styles).map((style) => style.split("/")[0]));
        for (const size of ["12px", "13px", "14px"]) expect(sizes.has(size)).toBe(true);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
