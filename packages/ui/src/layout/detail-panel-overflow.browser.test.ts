import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// QA B1 and B2 (21.11.): with classic scrollbars the detail body scrolled sideways (a child with `width: 100%` plus the
// text edge as margin), also in the phone sheet, and a second line lay under the first section. Headless Chromium hides
// its scrollbars by default, so this file launches it with them, as a desktop draws them.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "detail-panel-overflow.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Button, DetailPanel, FactGroup, Section } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const panel = () =>
  createComponent(DetailPanel, {
    get children() {
      const empty = document.createElement("div");
      return [
        createComponent(DetailPanel.Header, {
          title: "Follow up the Hofmann offer",
          kind: "Task",
          subtitle: "Sales · due tomorrow",
          menu: [{ label: "Copy link", action: () => {} }],
          primaryActions: createComponent(Button, { size: "sm", variant: "secondary", children: "Mark as done" }),
        }),
        // An empty node an app leaves between the bands draws no second line.
        empty,
        createComponent(DetailPanel.Body, {
          get children() {
            const hidden = document.createElement("span");
            hidden.hidden = true;
            const wide = document.createElement("div");
            wide.className = "wide";
            wide.style.width = "100%";
            wide.textContent = "A note that sets its own full width.";
            return [
              hidden,
              wide,
              createComponent(FactGroup, { title: "Details", items: [{ label: "Owner", value: "Jonas Weil" }, { label: "Customer", value: "Hofmann GmbH" }] }),
              createComponent(Section, { title: "Notes", children: "Confirm the price for 40 pallets." }),
            ];
          },
        }),
      ];
    },
  });
render(panel, document.getElementById("host"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail panel overflow fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// 390 px: the panel stands in the workspace's phone sheet; wider, in a 400 px column as beside a list.
const load = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const host =
    width < 768
      ? '<div class="k2b-app-workspace__detail" data-workspace-detail-sheet="full"><div id="host" style="height:100%"></div></div>'
      : '<div style="width:400px;height:600px;display:flex"><div id="host" style="flex:1;min-width:0"></div></div>';
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0">${host}</body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#host .k2b-detail-panel__body .wide").waitFor();
  await settled(page);
  return page;
};

const lines = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector("#host .k2b-detail-panel")!;
    const top = panel.getBoundingClientRect().top;
    const full = panel.getBoundingClientRect().width * 0.9;
    const body = panel.querySelector(".k2b-detail-panel__body")!.getBoundingClientRect().top;
    // Every visible top or bottom border across the panel (not a control's frame) from its top down to the body's top,
    // as y relative to the panel.
    const found: number[] = [];
    for (const element of [panel, ...Array.from(panel.querySelectorAll("*"))]) {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width < full) continue;
      for (const [side, y] of [
        ["top", box.top],
        ["bottom", box.bottom - 1],
      ] as const) {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
        if (width > 0 && style.getPropertyValue(`border-${side}-style`) !== "none" && y <= body + 1) found.push(Math.round(y - top));
      }
    }
    return found.sort((a, b) => a - b);
  });

describe("the detail panel with classic scrollbars", () => {
  for (const width of [390, 1100, 1440])
    test(`at ${width} px its body never scrolls sideways and the header draws one line per band`, async () => {
      const page = await load(width);
      try {
        const body = await page
          .locator("#host .k2b-detail-panel__body")
          .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(body.scroll).toBeLessThanOrEqual(body.client);
        // The full-width child ends on the text edge instead of running past it.
        const wide = await page.locator("#host .wide").evaluate((element) => {
          const parent = element.parentElement!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return box.right <= parent.left + element.parentElement!.clientWidth + 0.5;
        });
        expect(wide).toBe(true);
        const found = await page.evaluate(layoutProblems, { root: "#host" });
        expect({ double: found.double, sideways: found.sideways }).toEqual({ double: [], sideways: false });
        // Two lines above the body: under the 56 px bar, and under the first section (the body's top).
        const header = await lines(page);
        expect(header.length).toBe(2);
        expect(header[0]).toBe(56);
      } finally {
        await page.close();
      }
    });
});
