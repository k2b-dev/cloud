import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "workspace-inset.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(document.body.dataset.params);
const rows = (prefix = "row-") => Array.from({length:40}, (_, index) => {
  const row = document.createElement("div");
  row.id = prefix + index;
  row.textContent = "Row " + index;
  row.style.cssText = "height:40px;flex:none";
  return row;
});
render(() => createComponent(AppWorkspace, {
  get children() { return [
    createComponent(AppWorkspace.Sidebar, { mobile:params.has("stacked") ? "stacked" : "hidden", get children() {
      return createComponent(AppWorkspace.SidebarDesktop, { get children() { return [
        createComponent(AppWorkspace.SidebarBody, { get children() {
          return createComponent(AppWorkspace.SidebarItem, { href:"/devices", children:"Devices" });
        } }),
        createComponent(AppWorkspace.SidebarFooter, { get children() {
          return createComponent(AppWorkspace.SidebarItem, { href:"/settings", class:"fixture-sidebar-last", children:"Settings" });
        } }),
      ]; } });
    } }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { get children() { return [
        ...(params.has("panes") ? [createComponent(AppWorkspace.MainPane, {
          id:"navigation", label:"Navigation", surface:"navigation",
          get children() { return params.has("long-navigation") ? rows("navigation-row-") : "Folders"; },
        })] : []),
        ...rows(),
      ]; } }),
      createComponent(AppWorkspace.Detail, { id:"record", open:params.has("detail"), children:"Selected record" }),
    ]; } }),
    createComponent(AppWorkspace.BottomDrawer, { id:"events", open:params.has("drawer"), children:"Recent events" }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the workspace inset fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (params = "", width = 1180, inset = true, style = "") => {
  const page = await browser.newPage({ viewport: { width, height: 820 }, reducedMotion: "reduce" });
  // The inset belongs to the workspace edge, including when embedded away from the viewport edge.
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style><style>
    .k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}
    ${inset ? ".k2b-ui .k2b-app-workspace:not(.k2b-app-workspace *){--k2b-workspace-inset-bottom:20px}" : ""}
    ${style}
    </style></head><body class="k2b-ui" style="margin:0">
    <div id="app" style="height:640px;margin:40px 24px"></div></body></html>`);
  await page.evaluate((params) => {
    document.body.dataset.params = params;
  }, params);
  await page.addScriptTag({ content: script });
  await page.locator("#row-0").waitFor();
  await page.bringToFront();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page;
};

const geometry = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const border = Number.parseFloat(getComputedStyle(element).borderBottomWidth);
      return { top: rect.top, bottom: rect.bottom, border, contentBottom: rect.bottom - border };
    };
    const surface = (selector: string) => box(document.querySelector(selector)!);
    return {
      root: surface(".k2b-app-workspace"),
      sidebar: surface(".k2b-app-workspace__sidebar"),
      sidebarLast: surface(".fixture-sidebar-last"),
      main: surface(".k2b-app-workspace__main"),
      last: surface("#row-39"),
      drawer: surface(".k2b-app-workspace__drawer"),
      detail: surface(".k2b-app-workspace__detail"),
      regions: Array.from(document.querySelectorAll("[data-workspace-main-region]"), box),
    };
  });

test("sidebar and scrolling Main fill the bottom inset and keep their last items above it", async () => {
  const page = await load();
  try {
    const scrollTop = await page.evaluate(async () => {
      const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
      main.scrollTop = main.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return main.scrollTop;
    });
    const shape = await geometry(page);
    expect(scrollTop).toBeGreaterThan(0);
    for (const surface of [shape.sidebar, shape.main]) {
      expect(surface.bottom).toBeCloseTo(shape.root.bottom, 1);
      expect(surface.border).toBe(20);
      expect(surface.contentBottom).toBeCloseTo(shape.root.bottom - 20, 1);
    }
    expect(shape.last.bottom).toBeCloseTo(shape.root.bottom - 20, 1);
    expect(shape.sidebarLast.bottom).toBeLessThanOrEqual(shape.root.bottom - 20);
  } finally {
    await page.close();
  }
});

test("split Main keeps the bottom inset on each region, including navigation", async () => {
  const page = await load("panes");
  try {
    const shape = await geometry(page);
    expect(shape.main.border).toBe(0);
    expect(shape.regions).toHaveLength(2);
    for (const region of shape.regions) {
      expect(region.bottom).toBeCloseTo(shape.root.bottom, 1);
      expect(region.border).toBe(20);
      expect(region.contentBottom).toBeCloseTo(shape.root.bottom - 20, 1);
    }
    expect(await page.locator('[data-workspace-main-region="navigation"]').getAttribute("data-surface")).toBe("navigation");
  } finally {
    await page.close();
  }
});

test("an open bottom drawer owns the inset instead of Main", async () => {
  const page = await load("drawer");
  try {
    const shape = await geometry(page);
    expect(shape.drawer.bottom).toBeCloseTo(shape.root.bottom, 1);
    expect(shape.drawer.border).toBe(20);
    expect(shape.drawer.contentBottom).toBeCloseTo(shape.root.bottom - 20, 1);
    expect(shape.main.border).toBe(0);
    expect(shape.main.bottom).toBeLessThanOrEqual(shape.drawer.top);
  } finally {
    await page.close();
  }
});

test("floating detail keeps its own inset above the host's bottom inset", async () => {
  const page = await load("detail");
  try {
    const shape = await geometry(page);
    expect(shape.detail.bottom).toBeCloseTo(shape.root.bottom - 8 - 20, 1);
  } finally {
    await page.close();
  }
});

test("a stacked sidebar keeps no bottom inset above Main", async () => {
  const page = await load("stacked", 900);
  try {
    const shape = await geometry(page);
    expect(shape.sidebar.border).toBe(0);
    expect(shape.sidebar.bottom).toBeLessThanOrEqual(shape.main.top);
    expect(shape.main.bottom).toBeCloseTo(shape.root.bottom, 1);
    expect(shape.main.border).toBe(20);
    expect(shape.main.contentBottom).toBeCloseTo(shape.root.bottom - 20, 1);
  } finally {
    await page.close();
  }
});

// Screenshot pixels at one column, decoded in the page so the test needs no image library.
const pixels = async (page: Page, x: number, ys: number[]) => {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, x, ys }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return ys.map((y) => Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
    },
    { png, x, ys },
  );
};

// Rows are blue, the scroller's own surface yellow, and what lies behind it red.
const blue = [0, 0, 255];
const yellow = [255, 255, 0];
const red = [255, 0, 0];
const near = (actual: number[], expected: number[]) =>
  expect(
    actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 12),
    `${actual} is not ${expected}`,
  ).toBe(true);

for (const [name, params, scroller, behind] of [
  ["a scrolling Main", "", ".k2b-app-workspace__main", ".k2b-app-workspace"],
  ["a navigation pane", "panes long-navigation", '.k2b-app-workspace__main-pane[data-surface="navigation"]', ".k2b-app-workspace__main"],
] as const) {
  test(`${name} fades its last rows above the bottom inset, and the inset keeps the fade's end`, async () => {
    const page = await load(
      params.split(" ").join("&"),
      1180,
      true,
      `.k2b-ui ${behind}{background:rgb(255,0,0)}
      .k2b-ui ${scroller}{background:rgb(255,255,0);gap:0;padding:0}
      [id^="row-"],[id^="navigation-row-"]{background:rgb(0,0,255)}`,
    );
    try {
      const sample = async () => {
        const { x, bottom } = await page.evaluate((selector) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, bottom: rect.bottom };
        }, scroller);
        const [above, edge, inset] = await pixels(page, x, [bottom - 20 - 24, bottom - 20 - 2, bottom - 10]);
        return { above: above!, edge: edge!, inset: inset! };
      };
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-scroll-fade") === "bottom", scroller);
      const fading = await sample();
      near(fading.above, blue);
      // The last rows above the inset fade towards what lies behind the scroller.
      expect(fading.edge[0]!).toBeGreaterThan(160);
      expect(fading.edge[2]!).toBeLessThan(96);
      near(fading.inset, red);

      await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        element.scrollTop = element.scrollHeight;
      }, scroller);
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-scroll-fade") === "top", scroller);
      const end = await sample();
      near(end.edge, blue);
      near(end.inset, yellow);
    } finally {
      await page.close();
    }
  });
}

for (const params of ["", "drawer", "detail"]) {
  test(`without a host inset, ${params || "sidebar and Main"} keep their existing geometry`, async () => {
    const page = await load(params, 1180, false);
    try {
      const shape = await geometry(page);
      for (const surface of [shape.sidebar, shape.main, shape.drawer]) expect(surface.border).toBe(0);
      expect(shape.sidebar.bottom).toBeCloseTo(shape.root.bottom, 1);
      if (params === "drawer") expect(shape.drawer.bottom).toBeCloseTo(shape.root.bottom, 1);
      else expect(shape.main.bottom).toBeCloseTo(shape.root.bottom, 1);
      if (params === "detail") expect(shape.detail.bottom).toBeCloseTo(shape.root.bottom - 8, 1);
    } finally {
      await page.close();
    }
  });
}
