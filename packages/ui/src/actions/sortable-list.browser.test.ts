import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sortable-list.fixture.ts");
const source = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, SortableList } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [order, setOrder] = createSignal(["alpha", "beta", "gamma", "delta"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })));
window.order = () => order().map((item) => item.id);
window.moves = [];
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(SortableList, {
    get items() { return order(); },
    itemKey: (item) => item.id,
    itemLabel: (item) => item.name,
    label: "Pinned",
    onMove: (key, index) => {
      window.moves.push([key, index]);
      const next = order().filter((item) => item.id !== key);
      next.splice(index, 0, order().find((item) => item.id === key));
      // A host that saves gets newer copies of its items back; rows keep their elements and focus.
      setOrder(next.map((item) => ({ ...item })));
    },
    children: (item, handle) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.className = "name";
      row.append(handle, name);
      queueMicrotask(() => { name.textContent = item().name; });
      return row;
    },
  });
} }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: source }, target: "browser", conditions: ["browser"], format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sortable list fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style><style>
    body { margin: 0; } #app { width: 360px; padding: 20px; } .row { display: flex; align-items: center; gap: 8px; height: 44px; padding-inline: 4px; }
    </style></head><body class="k2b-ui"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-sortable-list__handle").first().waitFor();
  return { page, context };
};
const order = (page: Page) => page.evaluate(() => (window as unknown as { order: () => string[] }).order());
const boxes = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll(".k2b-sortable-list__item")].map((item) => JSON.stringify(item.getBoundingClientRect())));
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

describe(`sortable list in ${browserName}`, () => {
  test("a row dragged by its grip lands where the line shows, and nothing changes size meanwhile", async () => {
    const { page, context } = await open();
    try {
      const before = await boxes(page);
      const grip = await center(page, '[data-sortable-handle="alpha"]');
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 4, grip.y + 15);
      await page.locator(".k2b-drag-preview").waitFor();
      const target = await center(page, ".k2b-sortable-list__item >> nth=2");
      for (const step of [0.5, 1]) await page.mouse.move(target.x, grip.y + (target.y - grip.y) * step);
      await page.waitForFunction(() => document.querySelector('.k2b-sortable-list__target[data-drop="over"]') !== null);
      await settled(page);
      const during = await page.evaluate(() => {
        const over = document.querySelector('.k2b-sortable-list__target[data-drop="over"]')!.parentElement!;
        const line = getComputedStyle(over, "::before");
        return {
          side: over.getAttribute("data-sortable-side"),
          line: [line.content, line.height],
          dragged: document.querySelector("[data-sortable-dragging]")?.textContent,
          fill: getComputedStyle(over.firstElementChild!).backgroundColor,
        };
      });
      expect(during).toEqual({ side: "after", line: ['""', "2px"], dragged: "Alpha", fill: "rgba(0, 0, 0, 0)" });
      expect(await boxes(page)).toEqual(before);
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview, [data-drop], [data-sortable-dragging]"));
      expect(await order(page)).toEqual(["beta", "gamma", "alpha", "delta"]);
      // A press on the row's text is not a grip: it starts nothing.
      const name = await center(page, ".name >> nth=0");
      await page.mouse.move(name.x, name.y);
      await page.mouse.down();
      await page.mouse.move(name.x, name.y + 60, { steps: 4 });
      await page.mouse.up();
      expect(await page.locator(".k2b-drag-preview").count()).toBe(0);
      expect(await order(page)).toEqual(["beta", "gamma", "alpha", "delta"]);
    } finally {
      await context.close();
    }
  });

  test("the grip's arrow keys, Home and End move the row, keep focus, and say where it is", async () => {
    const { page, context } = await open();
    try {
      await page.locator('[data-sortable-handle="delta"]').focus();
      await page.keyboard.press("ArrowUp");
      expect(await order(page)).toEqual(["alpha", "beta", "delta", "gamma"]);
      await page.keyboard.press("Home");
      expect(await order(page)).toEqual(["delta", "alpha", "beta", "gamma"]);
      // The first row cannot move further up; nothing happens.
      await page.keyboard.press("ArrowUp");
      expect(await order(page)).toEqual(["delta", "alpha", "beta", "gamma"]);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-sortable-handle"))).toBe("delta");
      await page.waitForFunction(() => document.querySelector(".k2b-drag-announcer")?.textContent?.includes("Delta, position 1 of 4."));
      await page.keyboard.press("End");
      expect(await order(page)).toEqual(["alpha", "beta", "gamma", "delta"]);
      const handle = await page.locator('[data-sortable-handle="delta"]').evaluate((element) => ({
        name: element.getAttribute("aria-label"),
        hint: document.getElementById(element.getAttribute("aria-describedby")!)?.textContent,
        outline: getComputedStyle(element).outlineStyle,
      }));
      expect(handle).toEqual({ name: "Move Delta", hint: "Drag, or use the arrow keys, to change the order.", outline: "solid" });
    } finally {
      await context.close();
    }
  });
});
