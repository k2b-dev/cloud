import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Wide label–value rows stay readable: on a 1920 px screen a value stays within the row measure of its label, and a
// dotted leader appears only where a list opts in. Distances are layout, which only a real engine renders.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-wide-rows-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { BudgetList } = await import("./BudgetList");
const { DescriptionList } = await import("./DescriptionList");
const { BalanceSummary } = await import("../content/BalanceSummary");
const { LocaleProvider } = await import("../intl/locale");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const items = [
  { term: "Net amount", description: "€1,240.00" },
  { term: "VAT 19 %", description: "€235.60" },
  { term: "Total", description: "€1,475.60" },
];

test("on a 1920 px screen label and value stay within the row measure; the leader only appears when opted in", async () => {
  const wrapped = [{ term: "Total", description: "€1,475.60 including shipping and handling for two parcels to the warehouse" }];
  const render = (children: () => unknown) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return children() as never;
        },
      }),
    );
  const html =
    render(() => [
      createComponent(BudgetList, {
        currency: "EUR",
        items: [
          { label: "Purchasing", used: 9200, expected: 1800, limit: 15000 },
          { label: "Travel", used: 900, expected: 300, limit: 1000 },
        ],
      }),
      createComponent(BalanceSummary, { start: 18800, in: 29260, out: 29520, currency: "EUR" }),
      createComponent(DescriptionList, { items, layout: "rows", class: "plain" }),
      createComponent(DescriptionList, { items, layout: "rows", leader: "dotted", class: "leader" }),
      createComponent(DescriptionList, { items, layout: "compact", size: "sm", leader: "dotted", class: "leader-compact" }),
    ]) +
    `<div style="width:360px">${render(() => createComponent(DescriptionList, { items: wrapped, layout: "rows", size: "sm", leader: "dotted", class: "leader-wrapped" }))}</div>` +
    `<div dir="rtl">${render(() => createComponent(DescriptionList, { items, layout: "rows", leader: "dotted", class: "leader-rtl" }))}</div>`;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:40px">` +
        `<div style="width:1840px;display:grid;gap:32px">${html}</div></body></html>`,
    );
    await settled(page);
    const result = await page.evaluate(() => {
      const box = (element: Element | null) => element!.getBoundingClientRect();
      const text = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects();
      };
      const measure = Number.parseFloat(getComputedStyle(document.querySelector(".k2b-budget")!).maxWidth);
      const budget = Array.from(document.querySelectorAll(".k2b-budget__anchor")).map(
        (row) => box(row.querySelector(".k2b-budget__amount")).right - box(row.querySelector(".k2b-budget__label")).left,
      );
      const balance =
        box(document.querySelector(".k2b-balance > :last-child")).right - box(document.querySelector(".k2b-balance > :first-child")).left;
      // Text boxes, not cells: the value's first glyph sits next to the term's last one.
      const plain = Array.from(document.querySelectorAll(".plain .k2b-description-list__item")).map((row) => ({
        gap: Math.round(text(row.querySelector("dd")!)[0]!.left - text(row.querySelector("dt")!)[0]!.right),
        leader: getComputedStyle(row, "::before").content,
      }));
      const leader = (selector: string) =>
        Array.from(document.querySelectorAll(`${selector} .k2b-description-list__item`)).map((row) => {
          const style = getComputedStyle(row, "::before");
          const dd = row.querySelector("dd")!;
          const lines = text(dd);
          return {
            drawn: style.content === '""' && style.borderBottomStyle === "dotted" && Number.parseFloat(style.width) > 10,
            // The value's end in the inline direction, measured from the end of its cell.
            end: Math.round(getComputedStyle(row).direction === "rtl" ? lines[0]!.left - box(dd).left : box(dd).right - lines[0]!.right),
            firstLine: { top: lines[0]!.top, bottom: lines[0]!.bottom },
            lines: new Set(Array.from(lines).map((line) => Math.round(line.top))).size,
            term: text(row.querySelector("dt")!)[0]!.top,
          };
        });
      return {
        measure,
        budget: Math.max(...budget),
        balance,
        plain,
        leader: leader(".leader"),
        compact: leader(".leader-compact"),
        wrapped: leader(".leader-wrapped"),
        rtl: leader(".leader-rtl"),
      };
    });
    expect(result.measure).toBe(640);
    // A budget's amount ends within the row measure of its label, not at the far edge of a 1840 px panel.
    expect(result.budget).toBeLessThanOrEqual(result.measure);
    expect(result.balance).toBeLessThanOrEqual(result.measure);
    // Without the opt-in a description list keeps its value next to its term and draws no leader.
    for (const row of result.plain) expect(row.leader).toBe("none");
    expect(Math.max(...result.plain.map((row) => row.gap))).toBeLessThanOrEqual(120);
    // With leader="dotted" a leader is drawn and the value ends at the end of its cell, in rows, compact and RTL.
    for (const row of [...result.leader, ...result.compact, ...result.rtl, ...result.wrapped])
      expect({ drawn: row.drawn, end: row.end }).toEqual({ drawn: true, end: 0 });
    // A wrapped value keeps its term beside its first line.
    const [wrappedRow] = result.wrapped;
    expect(wrappedRow!.lines).toBeGreaterThan(1);
    expect(Math.abs(wrappedRow!.term - wrappedRow!.firstLine.top)).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
  }
});
