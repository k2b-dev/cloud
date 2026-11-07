import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-budget-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { ProgressBar, progressBarParts } = await import("./ProgressBar");
const { BudgetList, budgetState } = await import("./BudgetList");
const { BalanceSummary } = await import("../content/BalanceSummary");
const { LocaleProvider } = await import("../intl/locale");

const de = (fn: () => unknown) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return fn() as never;
      },
    }),
  );

describe("segmented progress bar", () => {
  test("within the budget the segments fill their share of the limit", () => {
    const bar = progressBarParts([{ value: 600 }, { value: 200, pattern: "hatched" }], 1000);
    expect(bar.parts).toEqual([
      { pattern: "solid", width: 60 },
      { pattern: "hatched", width: 20 },
    ]);
    expect(bar).toMatchObject({ total: 800, over: 0, mark: null, ratio: 0.8 });
  });

  test("over the budget the track spans the sum, the rest turns red and the limit gets a mark", () => {
    const bar = progressBarParts([{ value: 900 }, { value: 300, pattern: "hatched" }], 1000);
    expect(bar.parts.map((part) => [part.pattern, Math.round(part.width * 100) / 100])).toEqual([
      ["solid", 75],
      ["hatched", 8.33],
      ["over", 16.67],
    ]);
    expect(bar.over).toBe(200);
    expect(Math.round(bar.mark! * 100) / 100).toBe(83.33);
    // Booked spending alone beyond the limit clips at the limit; expected adds only red.
    expect(progressBarParts([{ value: 1200 }, { value: 100, pattern: "hatched" }], 1000).parts.map((part) => part.pattern)).toEqual([
      "solid",
      "over",
    ]);
  });

  test("negative, missing and empty values never draw", () => {
    expect(progressBarParts([{ value: -5 }, { value: Number.NaN }], 100).parts).toEqual([]);
    expect(progressBarParts([], 0)).toMatchObject({ parts: [], mark: null, ratio: 0 });
  });

  test("renders parts, mark and a spoken value; the plain bar is unchanged", () => {
    const html = renderToString(() =>
      createComponent(ProgressBar, {
        label: "Travel",
        segments: [{ value: 900 }, { value: 300, pattern: "hatched" }],
        limit: 1000,
        valueText: "900 € booked, 300 € expected, of 1,000 €",
      }),
    );
    expect(html).toContain("data-segmented");
    expect(html.match(/k2b-progress__segment"/g)?.length).toBe(3);
    expect(html).toContain('data-pattern="over"');
    expect(html).toContain("k2b-progress__limit");
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuetext="900 € booked, 300 € expected, of 1,000 €"');
    // Without a spoken value the overrun is said as a percent; `value` never contradicts the segments.
    const own = renderToString(() =>
      createComponent(ProgressBar, { label: "Travel", value: 20, segments: [{ value: 120 }], limit: 100, showValue: true }),
    );
    expect(own).toContain('aria-valuetext="120%"');
    expect(own).toContain(">120%<");
    const plain = renderToString(() => createComponent(ProgressBar, { label: "Upload", value: 42 }));
    expect(plain).toContain('style="width: 42%"');
    expect(plain).not.toContain("data-segmented");
  });
});

describe("budget list", () => {
  test("80 % of the budget is tight, more than 100 % is over", () => {
    expect(budgetState({ used: 500, expected: 200, limit: 1000 }).level).toBe("ok");
    expect(budgetState({ used: 600, expected: 200, limit: 1000 }).level).toBe("near");
    expect(budgetState({ used: 1000, limit: 1000 })).toMatchObject({ level: "near", free: 0, over: 0 });
    expect(budgetState({ used: 900, expected: 300, limit: 1000 })).toMatchObject({ level: "over", over: 200, total: 1200 });
  });

  test("float residue never tips a budget: exactly 100 % is not over, exactly 80 % is tight", () => {
    expect(budgetState({ used: 0.1, expected: 0.2, limit: 0.3 })).toMatchObject({ over: 0, level: "near" });
    expect(budgetState({ used: 0.7, expected: 0.1, limit: 1 }).level).toBe("near");
    expect(progressBarParts([{ value: 0.1 }, { value: 0.2 }], 0.3)).toMatchObject({ over: 0, mark: null });
  });

  test("an empty budget makes any spending over it, with the mark at the start", () => {
    expect(budgetState({ used: 10, limit: 0 })).toMatchObject({ over: 10, level: "over" });
    const bar = progressBarParts([{ value: 10 }], 0);
    expect(bar.parts).toEqual([{ pattern: "over", width: 100 }]);
    expect(bar.mark).toBe(0);
    expect(progressBarParts([{ value: 10 }], Number.NaN).over).toBe(10);
    // Without a limit the segments fill the track.
    expect(progressBarParts([{ value: 10 }]).over).toBe(0);
    const html = renderToString(() => createComponent(ProgressBar, { label: "Empty", segments: [{ value: 10 }], limit: 0 }));
    expect(html).toContain("k2b-progress__limit");
    expect(html).toContain('aria-valuetext="∞"');
  });

  test("each row says spent of budget, and the hint names what is left or over", () => {
    const html = de(() =>
      createComponent(BudgetList, {
        currency: "EUR",
        items: [
          { label: "Wareneinkauf", used: 9200, expected: 1800, limit: 15000 },
          { label: "Marketing", used: 1400, expected: 300, limit: 2000 },
          { label: "Reisen", used: 900, expected: 300, limit: 1000 },
        ],
      }),
    );
    expect(html).toMatch(/11\.000\s€ <span>von 15\.000\s€<\/span>/);
    expect(html).toMatch(/noch 4\.000\s€ frei/);
    expect(html).toMatch(/data-level="near"[^]*ti-alert-triangle[^]*knapp · noch 300\s€ frei/);
    expect(html).toMatch(/data-level="over"[^]*ti-alert-circle[^]*200\s€ über dem Budget/);
    expect(html).toMatch(/aria-valuetext="9\.200\s€ gebucht, 1\.800\s€ erwartet, von 15\.000\s€"/);
    expect(html).toContain("gebucht");
    expect(html).toContain("erwartet");
    expect(html).toContain("über dem Budget");
  });

  test("no budget shows the host's sentence and no legend", () => {
    const html = de(() => createComponent(BudgetList, { currency: "EUR", items: [], empty: "Noch keine Budgets." }));
    expect(html).toContain("Noch keine Budgets.");
    expect(html).not.toContain("k2b-budget__legend");
  });
});

describe("balance summary", () => {
  test("start plus in minus out equals end; in and out show their direction", () => {
    const html = de(() => createComponent(BalanceSummary, { start: 18800, in: 29260, out: 29520, currency: "EUR" }));
    expect(html).toMatch(/Anfang <b>18\.800\s€<\/b>/);
    expect(html).toMatch(/Ende <b>18\.540\s€<\/b>/);
    expect(html).toMatch(/data-direction="in"[^]*29\.260\s€[^]*, rein</);
    expect(html).toMatch(/data-direction="out"[^]*29\.520\s€[^]*, raus</);
    expect(html.match(/class="k2b-balance__op" aria-hidden="true"/g)?.length).toBe(3);
  });

  test("a broken figure shows a dash in its place and in the end, never a believable zero", () => {
    const html = de(() => createComponent(BalanceSummary, { start: 1000, in: Number.NaN, out: 200, currency: "EUR" }));
    expect(html).toMatch(/Ende <b>—<\/b>/);
    expect(html).toContain(", Betrag unbekannt<");
    expect(de(() => createComponent(BalanceSummary, { start: Number.NaN, in: 10, out: 0, currency: "EUR" }))).toMatch(/Anfang <b>—<\/b>/);
  });

  test("an explicit locale sets the words too", () => {
    const html = de(() => createComponent(BalanceSummary, { start: 100, in: 10, out: 5, currency: "EUR", locale: "en" }));
    expect(html).toContain("Start <b>€100</b>");
    expect(html).toContain(", in<");
    const budget = de(() =>
      createComponent(BudgetList, { currency: "EUR", locale: "en", items: [{ label: "Travel", used: 10, limit: 100 }] }),
    );
    expect(budget).toContain("€90 left");
  });

  test("whole amounts that would not add up show cents, so the line stays a true equation", () => {
    const html = de(() => createComponent(BalanceSummary, { start: 100.4, in: 0.4, out: 0, currency: "EUR" }));
    expect(html).toMatch(/Anfang <b>100,40\s€<\/b>/);
    expect(html).toMatch(/Ende <b>100,80\s€<\/b>/);
    expect(de(() => createComponent(BalanceSummary, { start: 18800, in: 29260, out: 29520, currency: "EUR" }))).toMatch(
      /Ende <b>18\.540\s€<\/b>/,
    );
  });

  test("a negative end keeps its sign; signs of in and out are ignored", () => {
    const html = de(() => createComponent(BalanceSummary, { start: 500, in: -200, out: -1000, currency: "EUR", decimals: 2 }));
    expect(html).toMatch(/Ende <b>-300,00\s€<\/b>/);
  });
});
