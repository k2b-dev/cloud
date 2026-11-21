import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../../test/head-overlap";

// Cloud flat (K7, K10, K15, K17): the geometry of the flat building blocks in a real layout engine. All data is invented.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "flat-blocks.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Area, Button, DataTable, DetailPanel, NoticeCard, Placeholder, RowGroup, Section, StatusBadge } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const row = (text) => { const div = document.createElement("div"); div.className = "row"; div.textContent = text; return div; };
render(() => [
  createComponent(Area, { id: "a1", name: "Stack 1", marker: 1, collapsible: true, count: 2, meta: "2 lists",
    state: createComponent(StatusBadge, { tone: "ok", label: "Complete" }),
    actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Reopen" }),
    get children() { return [row("L-1001"), row("L-1002")]; } }),
  createComponent(Area, { id: "a2", name: "Stack 2", marker: 2, collapsible: true, defaultOpen: false, count: 1,
    state: createComponent(StatusBadge, { tone: "warning", label: "Open" }), get children() { return row("L-1003"); } }),
  createComponent(Area, { id: "a3", name: "Stack 3", marker: 3, collapsible: true, empty: "No list yet" }),
  createComponent(RowGroup, { id: "g1", title: "Open", count: 2, get children() { return [row("Call the carrier"), row("Print labels")]; } }),
  createComponent(RowGroup, { id: "g2", title: "Done", count: 0 }),
], document.getElementById("areas"));

const columns = [
  { id: "name", header: "Name", value: "name", primary: true, list: "title" },
  { id: "place", header: "Place", value: "place", list: "meta" },
  { id: "owner", header: "Owner", value: "owner" },
  { id: "amount", header: "Amount", value: "amount", type: "amount", format: { currency: "EUR" }, list: "end" },
];
const rows = [
  { name: "Oak cabinet", place: "Shelf B 4", owner: "Mira", amount: 1240 },
  { name: "Brass lamp", place: "Shelf A 1", owner: "Jonte", amount: 85.5 },
];
render(() => createComponent(DataTable, { columns, rows, surface: "plain", ariaLabel: "Items" }), document.getElementById("table"));
render(() => createComponent(DataTable, { columns, rows: [...rows, { name: "Pine chest", place: "Hall 2", owner: "Mira", amount: 310 }], groupBy: "owner",
  collapsibleGroups: true, surface: "plain", ariaLabel: "Grouped items" }), document.getElementById("grouped"));

const notice = (id) => createComponent(NoticeCard, { id, tone: "warning", icon: true, title: "The receipt waits for a signature.",
  detail: "Payout starts after it is signed.", actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Open receipt" }) });
render(() => [notice("wide"), notice("narrow")], document.getElementById("notices"));
// One line, one owner: a table in a section in the detail column, and an alert cell between the rows of a list.
render(() => createComponent(DetailPanel, { get children() { return createComponent(DetailPanel.Body, { get children() { return [
  createComponent(Section, { title: "Items", icon: "ti ti-box", count: 2, get children() { return createComponent(DataTable, { columns, rows, ariaLabel: "Panel items" }); } }),
  createComponent(Section, { title: "Notes", icon: "ti ti-notes", children: "Collect on Friday." }),
]; } }); } }), document.getElementById("panel"));
// A page whose container divides its topics: each section stands on the container's one line.
render(() => [
  createComponent(Section, { title: "Contact", size: "md", children: "Mira Solberg" }),
  createComponent(Section, { title: "Notes", size: "md", children: "Collect on Friday." }),
], document.getElementById("divided"));
render(() => createComponent(RowGroup, { title: "Today", count: 3, get children() { return [
  row("Call the carrier"),
  createComponent(NoticeCard, { tone: "yours", icon: true, title: "The receipt waits for a signature.", actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Open receipt" }) }),
  row("Print labels"),
]; } }), document.getElementById("list"));
render(() => [
  createComponent(Placeholder, { surface: "paper", variant: "panel", icon: "ti ti-folder-off", title: "No projects yet", description: "Create the first project." }),
  createComponent(Placeholder, { state: "error", title: "The files could not load", onRetry: () => {} }),
], document.getElementById("empty"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the flat blocks fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>.row{height:40px;display:flex;align-items:center}#narrow-host{width:320px}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="areas"></div><div id="table"></div><div id="grouped"></div><div id="notices"></div><div id="empty"></div><div id="panel" style="width:380px"></div><div id="list"></div><div id="divided" class="k2b-divided"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#a3").waitFor();
  await settled(page);
  return page;
};

const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const { top, left, width, height, bottom, right } = element.getBoundingClientRect();
    return { top, left, width, height, bottom, right };
  });

describe("Cloud flat building blocks", () => {
  test("a closed area is one 40 px row; an open one has a 56 px head; toggling moves only what lies below", async () => {
    const page = await load(1440);
    try {
      // Closed: the height of a list row, without a gap or a surface.
      expect((await box(page, "#a2")).height).toBe(40);
      expect(await page.locator("#a2").evaluate((area) => getComputedStyle(area).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      expect((await box(page, "#a1 > .k2b-area__head")).height).toBe(56);
      // The empty area stays and says so.
      expect(await page.locator("#a3 .k2b-area__empty").textContent()).toBe("No list yet");

      const before = { a1: await box(page, "#a1"), a2: await box(page, "#a2"), a3: await box(page, "#a3") };
      await page.locator("#a2 .k2b-area__chevron").click();
      await settled(page);
      const opened = { a1: await box(page, "#a1"), a2: await box(page, "#a2"), a3: await box(page, "#a3") };
      // Nothing above and not the area's own head moves; only the area grows and what lies below follows.
      expect(opened.a1).toEqual(before.a1);
      expect(opened.a2.top).toBe(before.a2.top);
      expect((await box(page, "#a2 > .k2b-area__head")).height).toBe(56);
      // The next area follows by the growth and the 8 px that stand after an open area.
      expect(opened.a3.top - before.a3.top).toBe(opened.a2.height - before.a2.height + 8);
      expect(await page.locator("#a2 .k2b-area__chevron").getAttribute("aria-expanded")).toBe("true");

      await page.locator("#a1 .k2b-area__chevron").click();
      await settled(page);
      const closed = await box(page, "#a1");
      expect(closed.top).toBe(before.a1.top);
      expect(closed.height).toBe(40);
      // A closed row has no gap after it: the next area moves up by the shrink and the 8 px.
      expect((await box(page, "#a2")).top - opened.a2.top).toBe(closed.height - opened.a1.height - 8);
    } finally {
      await page.close();
    }
  });

  test("on a phone an open area keeps its name whole and a closed one stays a 40 px row", async () => {
    const page = await load(390);
    try {
      const names = await page
        .locator(".k2b-area__name")
        .evaluateAll((items) => items.map((name) => ({ text: name.textContent, cut: name.scrollWidth > name.clientWidth })));
      expect(names.filter((name) => name.cut)).toEqual([]);
      expect((await box(page, "#a2")).height).toBe(40);
      expect((await box(page, "#a1 > .k2b-area__head")).height).toBeGreaterThanOrEqual(56);
    } finally {
      await page.close();
    }
  });

  test("a group has a 36 px head and disappears when it is empty", async () => {
    const page = await load(1440);
    try {
      expect((await box(page, "#g1 > .k2b-row-group__head")).height).toBe(36);
      expect(await page.locator("#g2").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test("a table keeps a 36 px head and 40 px rows, and becomes a list of two-line entries below 480 px", async () => {
    const wide = await load(1440);
    try {
      expect((await box(wide, "#table thead th:first-child")).height).toBe(36);
      expect((await box(wide, "#table tbody tr:first-child")).height).toBe(40);
      // Numbers stand right-aligned and whole.
      const amount = await wide
        .locator("#table tbody tr td:last-child")
        .first()
        .evaluate((cell) => ({ align: getComputedStyle(cell).textAlign, cut: cell.scrollWidth > cell.clientWidth }));
      expect(amount).toEqual({ align: "right", cut: false });
    } finally {
      await wide.close();
    }
    const phone = await load(390);
    try {
      expect(await phone.locator("#table thead").isVisible()).toBe(false);
      const entry = await phone
        .locator("#table tbody tr:first-child")
        .first()
        .evaluate((row) => {
          const part = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
          const title = part('td[data-list="title"]');
          const meta = part('td[data-list="meta"]');
          const end = part('td[data-list="end"]');
          const owner = row.querySelector<HTMLElement>("td:not([data-list])")!;
          return {
            height: row.getBoundingClientRect().height,
            metaBelow: meta.top >= title.bottom,
            endRight: end.left >= title.right,
            ownerHidden: getComputedStyle(owner).display === "none",
          };
        });
      expect(entry.height).toBeGreaterThanOrEqual(60);
      expect(entry).toMatchObject({ metaBelow: true, endRight: true, ownerHidden: true });
    } finally {
      await phone.close();
    }
  });

  test("folding a table group keeps its 36 px head and moves only the rows below it", async () => {
    const page = await load(1440);
    try {
      const heads = () =>
        page.locator("#grouped .k2b-data-table__group-row").evaluateAll((items) =>
          items.map((row) => {
            const { top, height } = row.getBoundingClientRect();
            return { top, height };
          }),
        );
      const table = await box(page, "#table");
      const before = await heads();
      const toggle = page.locator("#grouped .k2b-data-table__group-toggle").first();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await toggle.click();
      await settled(page);
      const after = await heads();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await box(page, "#table")).toEqual(table);
      expect(after[0]).toEqual(before[0]);
      expect(after[0]!.height).toBe(36);
      // Mira's two rows of 40 px leave; the next head moves up by exactly them.
      expect(before[1]!.top - after[1]!.top).toBe(80);
      expect(await page.locator("#grouped tbody").first().locator(".k2b-data-table__row").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test("an alert cell is square and tinted; its deed stands beside the text when wide and below it when narrow", async () => {
    const page = await load(1440);
    try {
      // The same cell in a 320 px column.
      await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "narrow-host";
        document.body.append(host);
        host.append(document.querySelector("article#narrow")!);
      });
      await settled(page);
      const layout = (selector: string) =>
        page.locator(selector).evaluate((cell) => {
          const text = cell.querySelector(".k2b-notice-card__text")!.getBoundingClientRect();
          const actions = cell.querySelector(".k2b-notice-card__actions")!.getBoundingClientRect();
          const style = getComputedStyle(cell);
          return {
            radius: style.borderTopLeftRadius,
            tinted: style.backgroundColor !== "rgba(0, 0, 0, 0)",
            beside: actions.left >= text.right && actions.top < text.bottom,
            below: actions.top >= text.bottom,
          };
        });
      expect(await layout("article#wide")).toEqual({ radius: "0px", tinted: true, beside: true, below: false });
      expect(await layout("article#narrow")).toEqual({ radius: "0px", tinted: true, beside: false, below: true });
    } finally {
      await page.close();
    }
  });

  for (const width of [1440, 390])
    test(`at ${width} px every line has one owner: a table in a section in the detail column, an alert cell between rows`, async () => {
      const page = await load(width);
      try {
        for (const root of ["#panel", "#list", "#areas"]) {
          const found = await page.evaluate(layoutProblems, { root });
          expect({ root, double: found.double, sideways: found.sideways }).toEqual({ root, double: [], sideways: false });
        }
        // The alert cell has exactly one line before and after it: the list's own divider.
        const around = await page.locator("#list .k2b-notice-card").evaluate((cell) => {
          const style = getComputedStyle(cell);
          const next = getComputedStyle(cell.nextElementSibling!);
          return [style.borderTopWidth, style.borderTopColor === "rgba(0, 0, 0, 0)", next.borderTopWidth];
        });
        expect(around).toEqual(["1px", false, "1px"]);
      } finally {
        await page.close();
      }
    });

  test("a section in a k2b-divided container has exactly the container's one line", async () => {
    const page = await load(1440);
    try {
      const lines = await page.locator("#divided > .k2b-section").evaluateAll((sections) =>
        sections.map((section) => {
          const style = getComputedStyle(section);
          return [style.borderTopWidth, style.borderTopStyle, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth];
        }),
      );
      expect(lines).toEqual([
        ["0px", "none", "0px", "0px", "0px"],
        ["1px", "solid", "0px", "0px", "0px"],
      ]);
      expect((await page.evaluate(layoutProblems, { root: "#divided" })).double).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("an empty or failed area shows a round sign and no box", async () => {
    const page = await load(1440);
    try {
      const looks = await page.locator("#empty .k2b-placeholder").evaluateAll((items) =>
        items.map((item) => {
          const own = getComputedStyle(item);
          const sign = item.querySelector(".k2b-placeholder__icon")!;
          const style = getComputedStyle(sign);
          const box = sign.getBoundingClientRect();
          return {
            border: own.borderTopWidth === "0px" || own.borderTopColor === "rgba(0, 0, 0, 0)",
            shadow: own.boxShadow,
            round: Number.parseFloat(style.borderTopLeftRadius) >= box.width / 2,
            filled: style.backgroundColor !== "rgba(0, 0, 0, 0)",
            size: Math.round(box.width),
          };
        }),
      );
      expect(looks).toEqual([
        { border: true, shadow: "none", round: true, filled: true, size: 40 },
        { border: true, shadow: "none", round: true, filled: true, size: 32 },
      ]);
    } finally {
      await page.close();
    }
  });
});
