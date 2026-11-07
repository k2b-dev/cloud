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
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return [
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
        ];
      },
    }),
  );
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:40px">` +
        `<div style="width:1840px;display:grid;gap:32px">${html}</div></body></html>`,
    );
    await settled(page);
    const result = await page.evaluate(() => {
      const box = (element: Element | null) => element!.getBoundingClientRect();
      const measure = Number.parseFloat(getComputedStyle(document.querySelector(".k2b-budget")!).maxWidth);
      const budget = Array.from(document.querySelectorAll(".k2b-budget__anchor")).map(
        (row) => box(row.querySelector(".k2b-budget__amount")).right - box(row.querySelector(".k2b-budget__label")).left,
      );
      const balance =
        box(document.querySelector(".k2b-balance > :last-child")).right - box(document.querySelector(".k2b-balance > :first-child")).left;
      const rows = (selector: string) =>
        Array.from(document.querySelectorAll(`${selector} .k2b-description-list__item`)).map((row) => ({
          gap: Math.round(box(row.querySelector("dd")).left - box(row.querySelector("dt")).right),
          leader: getComputedStyle(row, "::before").borderBottomStyle,
        }));
      const leaderList = box(document.querySelector(".leader"));
      const valueEnds = Array.from(document.querySelectorAll(".leader dd")).map((dd) => {
        const range = document.createRange();
        range.selectNodeContents(dd);
        return Math.round(leaderList.right - range.getBoundingClientRect().right);
      });
      return { measure, budget: Math.max(...budget), balance, plain: rows(".plain"), leader: rows(".leader"), valueEnds };
    });
    expect(result.measure).toBe(640);
    // A budget's amount ends within the row measure of its label, not at the far edge of a 1840 px panel.
    expect(result.budget).toBeLessThanOrEqual(result.measure);
    expect(result.balance).toBeLessThanOrEqual(result.measure);
    // Without the opt-in a description list keeps its value next to its term and draws no leader.
    for (const row of result.plain) expect(row).toEqual({ gap: row.gap, leader: "none" });
    expect(Math.max(...result.plain.map((row) => row.gap))).toBeLessThanOrEqual(120);
    // With leader="dotted" the value aligns right and a dotted leader joins it to its term.
    for (const row of result.leader) expect(row.leader).toBe("dotted");
    // The value ends at its column, one column gap before the action column, as in rows with an action.
    expect(result.valueEnds.every((end) => end <= 13)).toBe(true);
  } finally {
    await page.close();
  }
});
