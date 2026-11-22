import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// Cloud flat: the shared columns, topics, and controls measured against the approved mockup (ui-flach v10, gemessen
// am 22.11.2026 in Chromium): the text edge is 20 px in every column from 768 px and 16 px below; a detail topic
// (`.psec`) has 16 px to its lines, a 20 px head, 8 px to its content and 24 px of indent after a plain symbol; a
// value row is 32 px; an alert cell (`.alert`) is 52 px with its sign on the text edge and its text 32 px further; a
// page topic (`.sec`) has a 52 px head band. All data is invented.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "flat-primitives.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Area, Button, DataTable, DatePicker, DescriptionList, DetailPanel, NoticeCard, NoticeRow, ProgressPath, Section, SegmentedControl, StatusBadge, Tabs, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const facts = [
  { term: "Status", description: "In progress" },
  { term: "Owner", description: "Mira Solberg" },
  { term: "Due", description: "Fri, Nov 27" },
];
render(() => createComponent(DetailPanel, { surface: "plain", get children() { return [
  createComponent(DetailPanel.Header, { title: "Check the contact form" }),
  createComponent(DetailPanel.Body, { get children() { return [
    createComponent(NoticeCard, { id: "alert", tone: "danger", icon: true, title: "The import stopped.", detail: "No rows since 09:40.",
      actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Open log" }) }),
    createComponent(Section, { id: "facts", title: "Details", icon: "ti ti-info-circle", get children() {
      return createComponent(DescriptionList, { layout: "rows", items: facts }); } }),
    createComponent(Section, { id: "money", title: "Money", icon: "ti ti-coin", iconColor: "#4d7c0f", children: "Paid in full." }),
    (() => { const page = document.createElement("div"); page.id = "own-page"; page.setAttribute("data-k2b-band", ""); page.style.height = "120px"; page.style.background = "#eef"; return page; })(),
    (() => { const p = document.createElement("p"); p.id = "plain"; p.textContent = "Plain guidance stays on the text edge."; return p; })(),
  ]; } }),
]; } }), document.getElementById("detail"));

const columns = [
  { id: "name", header: "Receipt", value: "name", primary: true },
  { id: "amount", header: "Amount", value: "amount", type: "amount", format: { currency: "EUR" } },
];
const rows = [{ name: "Q-2611-00021", amount: 532.3 }, { name: "Q-2610-00004", amount: 85.5 }];
render(() => createComponent(Section, { id: "page-topic", size: "md", title: "Deliveries", icon: "ti ti-package", iconColor: "#4338ca", count: 4,
  meta: "8 items run until tomorrow · 38 of 53 sold · next statement on Dec 15", get children() { return [
    createComponent(DataTable, { columns, rows, ariaLabel: "Receipts" }),
    createComponent(NoticeCard, { id: "page-alert", tone: "warning", icon: true, title: "The receipt waits for a signature." }),
    (() => { const p = document.createElement("p"); p.id = "page-plain"; p.textContent = "Collect on Friday."; return p; })(),
  ]; } }), document.getElementById("page"));
render(() => [
  createComponent(Section, { id: "page-text", size: "md", title: "Notes", children: "Collect on Friday." }),
  createComponent(Section, { id: "page-next", size: "md", title: "History", children: "Signed on Monday." }),
], document.getElementById("page-notes"));
render(() => [
  createComponent(NoticeRow, { id: "row-icon", icon: true, action: createComponent(Button, { id: "row-icon-action", size: "sm", variant: "secondary", children: "Open receipt" }),
    children: "The receipt waits for a signature." }),
  createComponent(NoticeRow, { id: "row-plain", action: createComponent(Button, { size: "sm", variant: "secondary", children: "Show" }), children: "2 items go back." }),
], document.getElementById("rows"));

render(() => [
  createComponent(Area, { id: "area-1", name: "EL-2611-00021", href: "#el-21", marker: 1, state: createComponent(StatusBadge, { tone: "warning", label: "Receipt open" }),
    meta: "arrived on Nov 17, 2026 · by post · 2 parcels · receipt sent on Nov 18", actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Open delivery" }),
    get children() { const r = document.createElement("div"); r.className = "row"; r.textContent = "Receipt Q-2611-00021"; return r; } }),
  createComponent(Area, { id: "area-2", name: "EL-2611-00009", marker: 2, empty: "No list yet" }),
], document.getElementById("areas"));

// A trailing part taller than the tabs makes the bar taller than its tabs, as in a head band.
render(() => createComponent(Tabs, { ariaLabel: "Record", value: "b", onValueChange: () => {},
  trailing: (() => { const tall = document.createElement("span"); tall.id = "tall"; tall.style.display = "block"; tall.style.height = "44px"; tall.style.width = "8px"; return tall; })(),
  options: [{ value: "a", label: "Overview" }, { value: "b", label: "Deliveries", count: "4" }, { value: "c", label: "Contact" }] }), document.getElementById("tabs"));

render(() => createComponent(ProgressPath, { label: "Path of the delivery", steps: [
  { label: "Arrived", detail: "Nov 17", done: true }, { label: "Listed", detail: "18 of 18", done: true },
  { label: "Ended", detail: "last day tomorrow", current: true }, { label: "Settled" }, { label: "Paid" }] }), document.getElementById("path"));

render(() => [
  (() => { const search = document.createElement("span"); search.textContent = "Search"; search.style.flex = "none"; search.style.width = "120px"; return search; })(),
  createComponent(SegmentedControl, { ariaLabel: "State", value: "open", onValueChange: () => {}, options: [
    { value: "open", label: "Waiting for signature" }, { value: "signed", label: "Signed" }, { value: "void", label: "Cancelled" }, { value: "all", label: "All states" }] }),
], document.getElementById("segments"));

render(() => [
  createComponent(TextInput, { label: "Name", value: "Mira" }),
  createComponent(DatePicker, { label: "Due", value: "2026-11-27" }),
], document.getElementById("fields"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the flat primitives fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const columnWidth = (width: number) => Math.min(380, width);
const load = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 1400 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>.row{height:40px;display:flex;align-items:center;line-height:20px}#plain,#page-plain,#segments>span{line-height:20px;margin-block:0}.col{border-inline:1px solid #e4e4e7}</style></head>` +
      `<body class="k2b-ui" style="margin:0">` +
      `<aside id="detail" class="col" data-layout-area style="width:${columnWidth(width)}px;height:640px;display:flex;flex-direction:column"></aside>` +
      `<main id="page" class="col" data-layout-area style="width:${Math.min(720, width)}px"></main>` +
      `<div id="page-notes" class="col" data-layout-area style="width:${Math.min(720, width)}px"></div>` +
      `<div id="rows" class="col" data-layout-area style="width:${Math.min(720, width)}px"></div>` +
      `<div id="areas" class="col" data-layout-area style="width:${Math.min(720, width)}px"></div>` +
      `<div id="tabs" class="col" data-layout-area style="width:${Math.min(720, width)}px"></div>` +
      `<div id="path" class="col" data-layout-area style="width:${Math.min(720, width)}px;padding-inline:var(--k2b-gutter)"></div>` +
      `<div id="segments" class="col" data-layout-area style="width:${Math.min(720, width)}px;padding-inline:var(--k2b-gutter);display:flex;align-items:center;gap:8px"></div>` +
      `<div id="fields" class="col" data-layout-area style="width:${Math.min(720, width)}px;padding-inline:var(--k2b-gutter);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px"></div>` +
      `</body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#area-2").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};

type Box = { top: number; left: number; width: number; height: number; bottom: number; right: number };
const box = (page: Page, selector: string): Promise<Box> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const { top, left, width, height, bottom, right } = element.getBoundingClientRect();
      return { top, left, width, height, bottom, right };
    });
/** The left edge of the first text in an element. */
const textLeft = (page: Page, selector: string): Promise<number> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width) return rect.left;
      }
      return Number.NaN;
    });

/** `layoutProblems` with every flat kind and no exceptions. */
const problems = async (page: Page): Promise<string[]> => (await page.evaluate(layoutProblems, { flat: true })).problems;

describe.each([1440, 390])("flat primitives at %i px", (width) => {
  const gutter = width >= 768 ? 20 : 16;

  test("the detail column adds no padding: its bands reach both edges and hold the text edge themselves", async () => {
    const page = await load(width);
    try {
      const body = await page.locator("#detail .k2b-detail-panel__body").evaluate((element) => {
        const { left, top } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        // The client box: inside the line the panel draws above the body.
        return {
          left,
          top: top + (element as HTMLElement).clientTop,
          right: left + (element as HTMLElement).clientWidth,
          padding: [style.paddingTop, style.paddingBottom, style.paddingLeft],
        };
      });
      expect(body.padding).toEqual(["0px", "0px", "0px"]);
      // The alert cell (`.alert`): tint from edge to edge, sign on the text edge, text 32 px further (20 + 12).
      const alert = await box(page, "#alert");
      expect([alert.left, alert.right]).toEqual([body.left, body.right]);
      expect(alert.top).toBe(body.top);
      expect((await box(page, "#alert .k2b-notice-card__icon")).left - body.left).toBe(gutter);
      expect((await textLeft(page, "#alert .k2b-notice-card__title")) - body.left).toBe(gutter + 32);
      // An app's own page marked as a band reaches both edges; plain content stands on the text edge.
      const own = await box(page, "#own-page");
      expect([own.left, own.right]).toEqual([body.left, body.right]);
      expect((await box(page, "#plain")).left - body.left).toBe(gutter);
    } finally {
      await page.close();
    }
  });

  test("a detail topic is the mockup's .psec: 16 px to its line, a 20 px head, 24 px indent, 32 px value rows", async () => {
    const page = await load(width);
    try {
      const body = await box(page, "#detail .k2b-detail-panel__body");
      const facts = await box(page, "#facts");
      const head = await box(page, "#facts .k2b-section__header");
      // The topic draws its hairline on top (1 px), then 16 px to its head.
      expect(head.top - facts.top).toBe(1 + 16);
      expect(head.height).toBe(20);
      expect((await textLeft(page, "#facts .k2b-section__title")) - body.left).toBe(gutter + 24);
      const rows = await page
        .locator("#facts .k2b-description-list__item")
        .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
      expect(rows.slice(1).map((top, index) => top - rows[index]!)).toEqual([32, 32]);
      expect(
        await page
          .locator("#facts .k2b-description-list__item")
          .first()
          .evaluate((item) => item.getBoundingClientRect().height),
      ).toBe(32);
      // Line, 16, head 20, 8, three values (24 + 8 + 24 + 8 + 24), 16: 149 px with its line, as `.psec` in Spaces.
      expect(facts.height).toBe(149);
      // Label 12, value 13 (K11).
      expect(
        await page
          .locator("#facts dd")
          .first()
          .evaluate((dd) => getComputedStyle(dd).fontSize),
      ).toBe("13px");
      // A symbol in a tile (area colour) starts the text 28 px in.
      expect((await textLeft(page, "#money .k2b-section__body")) - body.left).toBe(gutter + 28);
    } finally {
      await page.close();
    }
  });

  test("a page topic is the mockup's .sec: a 52 px head band, and its table and alert reach both edges", async () => {
    const page = await load(width);
    try {
      const topic = await box(page, "#page-topic");
      const head = await box(page, "#page-topic .k2b-section__header");
      if (width >= 768) expect(head.height).toBe(52);
      else expect(head.height).toBeGreaterThanOrEqual(52);
      const table = await box(page, "#page-topic .k2b-table-shell");
      expect([table.left, table.right]).toEqual([topic.left, topic.right]);
      expect(await page.locator("#page-topic .k2b-table-shell").evaluate((shell) => getComputedStyle(shell).boxShadow)).toBe("none");
      expect((await textLeft(page, "#page-topic td")) - topic.left).toBe(gutter);
      const alert = await box(page, "#page-alert");
      expect([alert.left, alert.right]).toEqual([topic.left, topic.right]);
      expect((await box(page, "#page-plain")).left - topic.left).toBe(gutter);
      // Plain text right in the body stands on the text edge too.
      expect((await textLeft(page, "#page-text .k2b-section__body")) - (await box(page, "#page-text")).left).toBe(gutter);
      // The meta line is never cut: beside the title when it fits, else on its own line on the title's text edge.
      const meta = await page.locator("#page-topic .k2b-section__meta").evaluate((element) => ({
        cut: element.scrollWidth > element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(meta.cut).toBe(false);
      expect(meta.right).toBeLessThanOrEqual(topic.right - gutter);
    } finally {
      await page.close();
    }
  });

  test("two page topics share one line, and a neutral notice row keeps its action and has no tint", async () => {
    const page = await load(width);
    try {
      // `.sec` owns the line between two topics; without a dividing host the second draws it above itself.
      expect(await page.locator("#page-text").evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
      expect(await page.locator("#page-next").evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("1px");
      // An icon never drops the row's one action.
      expect(await page.locator("#row-icon-action").isVisible()).toBe(true);
      // K10: a neutral row is a row like the others, without a tint; only a tone that asks to act now tints it.
      const tints = await page
        .locator("#rows .k2b-notice-card")
        .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).backgroundColor));
      expect(tints).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    } finally {
      await page.close();
    }
  });

  test("an area shows its state beside its linked name, wraps its meta, and shares one line with the next area", async () => {
    const page = await load(width);
    try {
      const name = await box(page, "#area-1 .k2b-area__name");
      const state = await box(page, "#area-1 .k2b-area__state");
      expect(state.left - name.right).toBe(8);
      expect(state.top).toBe(name.top);
      expect(await page.locator("#area-1 .k2b-area__name a").getAttribute("href")).toBe("#el-21");
      const area = await box(page, "#area-1");
      const meta = await page.locator("#area-1 .k2b-area__meta").evaluate((element) => ({
        cut: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
        right: element.getBoundingClientRect().right,
      }));
      expect(meta.cut).toBe(false);
      expect(meta.right).toBeLessThanOrEqual(area.right);
      expect((await box(page, "#area-2")).top).toBe(area.bottom);
    } finally {
      await page.close();
    }
  });

  test("the selected line tab's mark lies on the bar's line, also when the bar is taller than its tabs", async () => {
    const page = await load(width);
    try {
      const bar = await box(page, "#tabs .k2b-tabs__bar");
      expect(bar.height).toBe(44);
      const tab = await box(page, "#tabs [aria-selected=true]");
      expect(tab.bottom).toBe(bar.bottom);
      expect(await page.locator("#tabs .k2b-tabs__bar").evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
        "0px -1px 0px 0px inset",
      );
      expect(await page.locator("#tabs .k2b-tabs__list").evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
    } finally {
      await page.close();
    }
  });

  test("a progress path is a slim line through 10 px dots, green up to the current stage", async () => {
    const page = await load(width);
    try {
      const dots = await page.locator("#path .k2b-progress-path__marker").evaluateAll((items) =>
        items.map((item) => {
          const { width: w, height: h, top, left } = item.getBoundingClientRect();
          return { w, h, cy: top + h / 2, left };
        }),
      );
      expect(dots.map(({ w, h }) => [w, h])).toEqual(Array.from({ length: 5 }, () => [10, 10]));
      const container = await box(page, "#path");
      expect(dots[0]!.left - container.left - 1).toBe(gutter);
      const lines = await page.locator("#path .k2b-progress-path__step").evaluateAll((steps) =>
        steps.slice(0, -1).map((step) => {
          const line = getComputedStyle(step, "::before");
          return { height: line.height, width: line.width, color: line.backgroundColor, state: step.getAttribute("data-state") };
        }),
      );
      const done = await page.locator("#path").evaluate((path) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--k2b-success-text)";
        path.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      if (width >= 768) {
        expect(lines.map((line) => line.height)).toEqual(["2px", "2px", "2px", "2px"]);
        // The line's middle is the dots' middle: a 2 px line from cy − 1.
        const step = await box(page, "#path .k2b-progress-path__step");
        const top = await page
          .locator("#path .k2b-progress-path__step")
          .first()
          .evaluate((element) => getComputedStyle(element, "::before").top);
        expect(step.top + Number.parseFloat(top) + 1).toBe(dots[0]!.cy);
      } else expect(lines.map((line) => line.width)).toEqual(["2px", "2px", "2px", "2px"]);
      expect(lines.map((line) => line.color === done)).toEqual([true, true, false, false]);
    } finally {
      await page.close();
    }
  });

  test("a segmented control and a date field stay inside their column", async () => {
    const page = await load(width);
    try {
      const column = await box(page, "#segments");
      const control = await box(page, "#segments .k2b-segmented-control");
      expect(control.right).toBeLessThanOrEqual(column.right - 1 - gutter);
      const options = await page
        .locator("#segments .k2b-segmented-control__option")
        .evaluateAll((items) =>
          items.map(
            (item) =>
              item.scrollWidth <= item.clientWidth &&
              item.getBoundingClientRect().right <= item.parentElement!.getBoundingClientRect().right + 0.5,
          ),
        );
      expect(options).toEqual([true, true, true, true]);
      // The date field is exactly as wide as the text field beside it and as its own grid cell.
      const cells = await page.locator("#fields > .k2b-field").evaluateAll((fields) =>
        fields.map((field) => {
          const shell = field.querySelector(".k2b-input-shell")!.getBoundingClientRect();
          const own = field.getBoundingClientRect();
          return {
            cell: Math.round(own.width * 100) / 100,
            shell: Math.round(shell.width * 100) / 100,
            spill: Math.round((shell.right - own.right) * 100) / 100,
          };
        }),
      );
      expect(cells[1]!.shell).toBe(cells[0]!.shell);
      expect(cells.map((cell) => cell.spill)).toEqual([0, 0]);
    } finally {
      await page.close();
    }
  });

  test("the layout check finds nothing", async () => {
    const page = await load(width);
    try {
      expect(await problems(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
