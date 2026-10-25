import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// How far a row's label reaches depends on layout and on the painted mask,
// which happy-dom does not model, so a real engine runs the shipped build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
// Overflows one line at the default 208 px sidebar in any engine.
const long = "Social Media Campaign Planning for the Northern Region";
const entry = resolve(import.meta.dir, "sidebar-row-label-room.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, IconButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const label = (children) => createComponent(AppWorkspace.SidebarItemLabel, { children, marquee: false });
const count = (children) => createComponent(AppWorkspace.SidebarItemMeta, { children });
const dot = () => createComponent(AppWorkspace.SidebarItemIcon, { children: "•" });
const group = (labels) =>
  createComponent(AppWorkspace.SidebarItemActions, {
    visibility: "hover",
    get children() {
      return labels.map((label) => createComponent(IconButton, { label, size: "xs", variant: "text", children: "+" }));
    },
  });
const [wide, setWide] = createSignal(false);
window.setWide = setWide;
const action = (label) => createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label, visibility: "hover" });
// Spaces renders its spaces as these rows: a dot, a one-line name, an open count and a pin that shows on hover.
const rows = [
  { href: "#count-pin", get actions() { return group(["Pin"]); }, children: [dot(), label(${JSON.stringify(long)}), count("12")] },
  { href: "#active", active: true, get actions() { return group(["Pin"]); }, children: [dot(), label(${JSON.stringify(long)}), count("12")] },
  { href: "#pin", get actions() { return group(["Pin"]); }, children: [dot(), label(${JSON.stringify(long)})] },
  { href: "#count-pin-hide", get actions() { return group(["Pin", "Hide"]); }, children: [dot(), label(${JSON.stringify(long)}), count("12")] },
  { href: "#count-action", children: [dot(), label(${JSON.stringify(long)}), count("12"), action("More")] },
  // Chat marks unread rows with a status.
  {
    href: "#status-pin",
    meta: createComponent(AppWorkspace.SidebarItemStatus, { unread: 3 }),
    get actions() { return group(["Pin"]); },
    children: [dot(), label(${JSON.stringify(long)})],
  },
  // An empty status takes no room.
  {
    href: "#empty-status-pin",
    meta: createComponent(AppWorkspace.SidebarItemStatus, { unread: 0 }),
    get actions() { return group(["Pin"]); },
    children: [dot(), label(${JSON.stringify(long)})],
  },
  // The application swaps its actions for a wider group while the row stays.
  {
    href: "#swap",
    get actions() { return group(wide() ? ["Pin", "Hide"] : ["Pin"]); },
    children: [dot(), label(${JSON.stringify(long)}), count("12")],
  },
];
// Notebooks reveals its note actions before a tree row's chevron.
const tree = () =>
  createComponent(AppWorkspace.NavTree, {
    ariaLabel: "Notes",
    get children() {
      return createComponent(AppWorkspace.NavTree.Item, {
        id: "tree",
        label: ${JSON.stringify(long)},
        href: "#tree",
        get actions() { return group(["Add", "More"]); },
        get children() { return createComponent(AppWorkspace.NavTree.Item, { id: "leaf", label: "Leaf", href: "#leaf" }); },
      });
    },
  });
render(() => createComponent(AppWorkspace, {
  resizable: false,
  get children() { return [
    createComponent(AppWorkspace.Sidebar, {
      get children() { return createComponent(AppWorkspace.SidebarDesktop, {
        get children() { return createComponent(AppWorkspace.SidebarBody, {
          get children() {
            return createComponent(AppWorkspace.SidebarSection, {
              get children() { return [...rows.map((row) => createComponent(AppWorkspace.SidebarItem, row)), tree()]; },
            });
          },
        }); },
      }); },
    }),
    createComponent(AppWorkspace.Content, {
      get children() { return createComponent(AppWorkspace.Main, { children: "Board" }); },
    }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar label room fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: { rtl?: boolean } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html${options.rtl ? ' lang="ar" dir="rtl"' : ' lang="en"'}><head><style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important}.k2b-app-workspace__sidebar{--k2b-workspace-sidebar-width:208px}</style></head>" +
      '<body class="k2b-ui" data-theme="light" style="margin:0"><div id="app" style="height:48rem"></div></body></html>',
  );
  await page.evaluate(() => Promise.all(["400 13px 'IBM Plex Sans'", "600 13px 'IBM Plex Sans'"].map((font) => document.fonts.load(font))));
  await page.addScriptTag({ content: script });
  await page.locator('[href="#pin"]').waitFor();
  await page.mouse.move(1200, 700);
  return page;
};

/**
 * Paints the label as a solid bar, so its mask is the only thing that dims
 * it, and reads one pixel line through it. Returns, measured from the row's
 * start along the line, how far the label is still at least half opaque and
 * where the first control that the row shows at its end begins: its count or
 * a revealed action.
 */
const room = async (page: Page, id: string) => {
  const row = page.locator(".k2b-app-workspace__sidebar-item", { has: page.locator(`[href="#${id}"]`) });
  const geometry = await row.evaluate((element) => {
    const rtl = getComputedStyle(element).direction === "rtl";
    const box = element.getBoundingClientRect();
    const inline = (x: number) => (rtl ? box.right - x : x - box.left);
    const label = element.querySelector(".k2b-app-workspace__sidebar-item-label-text")!;
    const text = label.getBoundingClientRect();
    // A tree row's label wraps onto a second line that fades over half its width; the first line ends at the control.
    const line = Math.min(text.height, Number.parseFloat(getComputedStyle(label).lineHeight) || text.height);
    const shown = (node: Element) => {
      for (let current: Element | null = node; current && current !== element.parentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.opacity === "0" || style.display === "none") return false;
      }
      return getComputedStyle(node).visibility === "visible";
    };
    const ends = Array.from(
      element.querySelectorAll(
        ".k2b-app-workspace__sidebar-item-meta, .k2b-app-workspace__sidebar-item-actions > *, .k2b-app-workspace__sidebar-item-action, .k2b-app-workspace__nav-tree-toggle",
      ),
    )
      .filter(shown)
      .map((node) => {
        const control = node.getBoundingClientRect();
        return inline(rtl ? control.right : control.left);
      });
    return {
      rtl,
      left: box.left,
      right: box.right,
      y: text.top + line / 2,
      from: text.left,
      to: text.right,
      end: Math.min(...ends, box.width),
    };
  });
  const bar = await page.addStyleTag({
    content:
      ".k2b-app-workspace__sidebar-item-label-text{color:transparent!important;background:#000!important}" +
      ":is(.k2b-app-workspace__sidebar-item-meta,.k2b-app-workspace__sidebar-item-actions,.k2b-app-workspace__sidebar-item-action,.k2b-app-workspace__nav-tree-toggle) *{color:transparent!important}",
  });
  const png = (await page.screenshot()).toString("base64");
  await bar.evaluate((element) => element.parentNode?.removeChild(element));
  const reach = await page.evaluate(
    async ({ png, rtl, left, right, y, from, to }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const line = context.getImageData(0, Math.round(y), image.width, 1).data;
      let reach = 0;
      for (let x = Math.round(from); x < Math.round(to); x++) {
        if ((line[x * 4]! + line[x * 4 + 1]! + line[x * 4 + 2]!) / 3 >= 128) continue;
        reach = Math.max(reach, rtl ? right - x : x + 1 - left);
      }
      return reach;
    },
    { png, ...geometry },
  );
  return { reach: Math.round(reach), end: Math.round(geometry.end) };
};

const hover = async (page: Page, id: string) => {
  const box = (await page.locator(`[href="#${id}"]`).boundingBox())!;
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
};

describe("sidebar row label room", () => {
  for (const rtl of [false, true]) {
    test(`${rtl ? "right-to-left" : "left-to-right"}: a long label fades out right before the count or the revealed hover action, at rest, hovered and active`, async () => {
      const page = await load({ rtl });
      try {
        const results: Record<string, { reach: number; end: number }> = {};
        await settled(page);
        for (const id of ["count-pin", "active", "pin", "count-pin-hide", "count-action", "status-pin", "empty-status-pin", "swap", "tree"])
          results[`${id} at rest`] = await room(page, id);
        for (const id of ["count-pin", "pin", "count-pin-hide", "count-action", "status-pin", "empty-status-pin", "swap", "tree"]) {
          await hover(page, id);
          await settled(page);
          results[`${id} hovered`] = await room(page, id);
        }
        await page.evaluate(() => (window as unknown as { setWide: (wide: boolean) => void }).setWide(true));
        await page.locator('.k2b-app-workspace__sidebar-item:has([href="#swap"]) [aria-label="Hide"]').waitFor({ state: "attached" });
        await hover(page, "swap");
        await settled(page);
        results["swap hovered with a wider group"] = await room(page, "swap");
        // The label stays at least half opaque until its own 0.75rem fade and the row's 0.5rem gap before the first
        // control at the row's end, and never reaches under it. Before the fix, a label beside a count gave up the
        // room of the revealed pin a second time and ended about 3.5rem before it.
        const misses = Object.entries(results)
          .filter(([, { reach, end }]) => end - reach < 0 || end - reach > 20)
          .map(([state, { reach, end }]) => `${state}: label reaches ${reach}, first control at ${end}`);
        expect(misses).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
