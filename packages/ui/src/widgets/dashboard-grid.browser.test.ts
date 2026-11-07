import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dashboard-grid.fixture.ts");
// Two sections: a key-figure row above a two-thirds and a third panel, then a half pair, three thirds and a full panel.
const fixture = `
import { createComponent, render } from "solid-js/web";
import { DashboardGrid, DashboardPanel, DashboardSection, StatCell, StatGrid } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const panel = (id, width) => createComponent(DashboardPanel, {
  "data-panel": id, width,
  get children() {
    const button = document.createElement("button");
    button.textContent = id;
    const body = document.createElement("div");
    body.className = "body";
    body.style.height = "120px";
    return [button, body];
  },
});
render(() => createComponent(DashboardGrid, { get children() { return [
  createComponent(DashboardSection, { title: "Impact", icon: "ti ti-chart-dots", description: "Recipients · one dot is 5 %", get children() { return [
    createComponent(StatGrid, { columns: 4, get children() { return ["Subscribers", "Open rate", "Click rate", "Unsubscribes"].map((label, index) => createComponent(StatCell, { label, value: 100 + index })); } }),
    panel("two-thirds", "twoThirds"), panel("third", "third"),
  ]; } }),
  createComponent(DashboardSection, { ariaLabel: "Detail", get children() { return [
    panel("half-a", "half"), panel("half-b", "half"), panel("t1"), panel("t2", "third"), panel("t3", "third"), panel("full", "full"),
  ]; } }),
]; } }), document.getElementById("host"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle dashboard grid fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const mount = async (page: Page, hostWidth: number, theme = "light") => {
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0"><div id="host" style="width:${hostWidth}px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await settled(page);
};

// Columns each panel spans, read from its width on six columns with 16 px gaps.
const spans = (page: Page) =>
  page.evaluate(() => {
    const result: Record<string, number> = {};
    for (const grid of document.querySelectorAll(".k2b-dashboard-section__grid")) {
      const width = grid.getBoundingClientRect().width;
      for (const panel of grid.querySelectorAll(":scope > [data-panel]"))
        result[panel.getAttribute("data-panel")!] = Math.round(((panel.getBoundingClientRect().width + 16) / (width + 16)) * 6);
    }
    return result;
  });
const boxes = (page: Page) =>
  page.locator("[data-panel]").evaluateAll((panels) =>
    panels.map((panel) => {
      const box = panel.getBoundingClientRect();
      return [panel.getAttribute("data-panel"), box.x, box.y, box.width, box.height];
    }),
  );

test("widths fold on the dashboard's own width, not the window's", async () => {
  // The window is always wide; only the host that holds the dashboard changes.
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = pageErrors(page);
  try {
    for (const [host, expected] of [
      [1200, { "two-thirds": 4, third: 2, "half-a": 3, "half-b": 3, t1: 2, t2: 2, t3: 2, full: 6 }],
      [900, { "two-thirds": 6, third: 3, "half-a": 3, "half-b": 3, t1: 3, t2: 3, t3: 3, full: 6 }],
      [560, { "two-thirds": 6, third: 6, "half-a": 6, "half-b": 6, t1: 6, t2: 6, t3: 6, full: 6 }],
    ] as const) {
      await mount(page, host);
      expect({ host, spans: await spans(page) }).toEqual({ host, spans: expected });
      // The key-figure row spans the grid above the first panels.
      const row = await page.evaluate(() => {
        const grid = document.querySelector(".k2b-dashboard-section__grid")!.getBoundingClientRect();
        const tiles = document.querySelector(".k2b-stat-grid")!.getBoundingClientRect();
        const first = document.querySelector('[data-panel="two-thirds"]')!.getBoundingClientRect();
        return { full: Math.abs(tiles.width - grid.width) < 1, above: tiles.bottom <= first.top };
      });
      expect({ host, ...row }).toEqual({ host, full: true, above: true });
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

for (const theme of ["light", "dark"])
  test(`every panel is one light frame and the section icon is a plain glyph in ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await mount(page, 1200, theme);
      const frames = await page.locator("[data-panel]").evaluateAll((panels) => [
        ...new Set(
          panels.map((panel) => {
            const style = getComputedStyle(panel);
            return [
              style.borderTopWidth,
              style.borderTopStyle,
              style.borderTopLeftRadius,
              style.paddingTop,
              style.paddingLeft,
              style.boxShadow,
            ].join(" ");
          }),
        ),
      ]);
      expect(frames).toEqual(["1px solid 12px 14px 16px none"]);
      const header = await page
        .locator(".k2b-dashboard-section__header")
        .first()
        .evaluate((element) => {
          const icon = getComputedStyle(element.querySelector(".k2b-dashboard-section__icon")!);
          const title = getComputedStyle(element.querySelector("h2")!);
          const description = element.querySelector("p")!.getBoundingClientRect();
          const heading = element.querySelector("h2")!.getBoundingClientRect();
          return {
            iconSize: icon.fontSize,
            iconBackground: icon.backgroundColor,
            titleSize: title.fontSize,
            titleWeight: title.fontWeight,
            // The description follows the title on the same line while there is room.
            sameLine: Math.abs(description.top + description.height / 2 - (heading.top + heading.height / 2)) < 2,
          };
        });
      expect(header).toEqual({
        iconSize: "20px",
        iconBackground: "rgba(0, 0, 0, 0)",
        titleSize: "15px",
        titleWeight: "600",
        sameLine: true,
      });
      expect(await page.getByRole("region", { name: "Impact", exact: true }).count()).toBe(1);
      expect(await page.getByRole("region", { name: "Detail", exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

test("a state change at the same content height moves no panel, and keyboard order follows reading order", async () => {
  for (const host of [1200, 900, 390]) {
    const page = await browser.newPage({ viewport: { width: Math.max(host, 390), height: 1600 } });
    try {
      await mount(page, host);
      const before = await boxes(page);
      // Panels in one row share the tallest height; a state with the same content height changes nothing at all.
      await page.locator('[data-panel="third"] .body').evaluate((body) => {
        body.textContent = "Could not load";
      });
      expect(await boxes(page)).toEqual(before);
      // Reading order: top to bottom, then left to right, is the order Tab visits the panels in.
      const visual = [...before]
        .sort((a, b) => (a[2] as number) - (b[2] as number) || (a[1] as number) - (b[1] as number))
        .map((box) => box[0]);
      expect(visual).toEqual(before.map((box) => box[0]));
      await page.locator('[data-panel="two-thirds"] button').focus();
      const visited: (string | null | undefined)[] = [];
      for (let index = 0; index < before.length; index += 1) {
        visited.push(await page.evaluate(() => document.activeElement?.closest("[data-panel]")?.getAttribute("data-panel")));
        await page.keyboard.press("Tab");
      }
      expect({ host, visited }).toEqual({ host, visited: before.map((box) => box[0]) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  }
}, 30_000);
