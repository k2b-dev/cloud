import { expect, test } from "bun:test";
import { balanceFixture } from "../../../test/charts/balance-flow-fixture";
import {
  BalanceFlowError,
  balanceFlowHeight,
  balanceFlowLayout,
  balanceFlowRows,
  balanceFlowSummary,
  renderBalanceFlowSvg,
  validateBalanceFlow,
} from "./balance-flow";
import { renderBalanceFlowHtml } from "./balance-flow-frame";
import { isChartDatum } from "./inspection";
import { prepareChartSnapshot } from "./snapshot";
import { chartTextWidth } from "./text";

test("exact decimal equations and carry-forward reject every inconsistent period without correcting data", () => {
  expect(() => validateBalanceFlow(balanceFixture.periods)).not.toThrow();
  const decimal = [{ label: "Decimals", opening: 0.1, inflows: [{ label: "Order", value: 0.2 }], outflows: [], closing: 0.3 }];
  expect(() => validateBalanceFlow(decimal)).not.toThrow();
  for (const closing of [0.30000000000000004, 0.31, NaN, Infinity])
    expect(() => validateBalanceFlow([{ ...decimal[0]!, closing }])).toThrow();
  expect(() => validateBalanceFlow([{ ...balanceFixture.periods[0]!, closing: 2001 }])).toThrow("must equal closing");
  expect(() => validateBalanceFlow([balanceFixture.periods[0]!, { ...balanceFixture.periods[1]!, opening: 1999, closing: 1499 }])).toThrow(
    "previous period",
  );
  expect(() =>
    validateBalanceFlow([{ label: "Bad flow", opening: 1, inflows: [{ label: "In", value: -1 }], outflows: [], closing: 0 }]),
  ).toThrow();
  expect(() =>
    validateBalanceFlow([{ label: "Small", opening: 1e-7, inflows: [{ label: "In", value: 2e-7 }], outflows: [], closing: 3e-7 }]),
  ).not.toThrow();
});
test("Sankey geometry balances the neutral middle and preserves the balance colour into the next period", () => {
  for (let period = 0; period < balanceFixture.periods.length; period++) {
    const scene = balanceFlowLayout({ ...balanceFixture, period });
    const middle = scene.nodes.find((n) => n.id === "balance")!;
    expect(middle.incoming).toBe(middle.outgoing);
    expect(scene.links).toHaveLength(balanceFixture.periods[period]!.inflows.length + balanceFixture.periods[period]!.outflows.length + 2);
    expect(scene.height).toBe(balanceFlowHeight(balanceFixture.periods));
    for (const n of scene.nodes) expect(n.y + n.height).toBeLessThanOrEqual(scene.height);
  }
  for (let period = 0; period < balanceFixture.periods.length - 1; period++) {
    const left = balanceFlowLayout({ ...balanceFixture, period }),
      right = balanceFlowLayout({ ...balanceFixture, period: period + 1 });
    const closing = left.nodes.find((n) => n.id === "closing")!,
      opening = right.nodes.find((n) => n.id === "opening")!;
    expect(closing.y).toBe(opening.y);
    expect(closing.height).toBe(opening.height);
    expect(closing.x + left.nodeWidth).toBe(left.width);
    expect(opening.x).toBe(0);
    expect(closing.y + closing.height).toBe(left.bottom);
    expect(opening.y + opening.height).toBe(right.bottom);
    expect(left.scale).toBe(right.scale);
  }
  const first = renderBalanceFlowSvg({ ...balanceFixture, inspect: true }),
    second = renderBalanceFlowSvg({ ...balanceFixture, period: 1, inspect: true });
  const balancePaint = (svg: string, key: string) => new RegExp(`data-balance-key="${key}"[^>]*fill="([^"]+)"`).exec(svg)?.[1];
  expect(balancePaint(first, "closing")).toBe(balancePaint(second, "opening"));
  expect(first).toContain("--k2b-flow-in-mark,#0891b2");
  expect(first).toContain("--k2b-flow-out-mark,#8b5cf6");
  expect(first).not.toMatch(/green|red|danger|success|#(?:000|10b981|16a34a|ef4444|dc2626)\b/i);
  expect(first).not.toContain("textLength");
});
test("negative and zero balances stay explicit, headers and snapshot metadata retain the author's amounts", () => {
  const negative = {
    currency: "EUR",
    locale: "de",
    periods: [
      {
        label: "Oktober",
        opening: -50,
        inflows: [{ label: "Bestellungen", value: 80 }],
        outflows: [{ label: "Gebühren", value: 50 }],
        closing: -20,
      },
    ],
  };
  const scene = balanceFlowLayout(negative);
  expect(scene.nodes.find((n) => n.id === "balance")!.incoming).toBe(100);
  expect(scene.nodes.find((n) => n.id === "balance")!.outgoing).toBe(100);
  expect(balanceFlowRows(negative)[0]!.label).toBe("Anfang (geschuldet)");
  expect(balanceFlowSummary(negative)).toContain("Schluss 20,00");
  const svg = renderBalanceFlowSvg({ ...balanceFixture, title: "Settlement overview", subtitle: "Invented data" });
  expect(svg.match(/>Settlement overview</g)).toHaveLength(1);
  const snapshot = prepareChartSnapshot(
    { kind: "balanceFlow", ...balanceFixture },
    { key: (s) => `${s.datum.seriesIndex}:${s.datum.index}`, tooltip: () => ({ rows: [] }) },
  );
  expect(snapshot.kind).toBe("balanceFlow");
  expect(snapshot.stretch).toBe(false);
  expect(snapshot.marks.length).toBeGreaterThan(0);
});
test("server frame contains all months and starts at the newest scroll origin across stable states", () => {
  const markup = renderBalanceFlowHtml({ ...balanceFixture, title: "Marketplace payout" });
  expect(markup).toContain('data-balance-step="1" aria-label="Next period" disabled');
  expect(markup).toContain('data-balance-month="3"');
  expect(markup).toContain("Marketplace orders");
  expect(markup).not.toContain("<template");
  expect(markup).toContain('data-period="3"');
  expect(markup).toContain("data-balance-scroll");
  expect(markup.match(/data-balance-period="/g)).toHaveLength(4);
  expect(markup.match(/<table /g)).toHaveLength(4);
  for (const state of ["loading", "empty", "error", "stale"] as const) {
    const other = renderBalanceFlowHtml(balanceFixture, state);
    expect(/--k2b-balance-flow-height:(\d+)px/.exec(other)?.[1]).toBe(/--k2b-balance-flow-height:(\d+)px/.exec(markup)?.[1]);
  }
  const invalid = renderBalanceFlowHtml({ ...balanceFixture, periods: [{ ...balanceFixture.periods[0]!, closing: 99 }] });
  expect(invalid).toContain('data-state="error"');
  expect(invalid).toContain("The amounts do not balance");
  expect(renderBalanceFlowHtml({ currency: "EUR", periods: [] })).toContain("No periods to show.");
  expect(balanceFlowLayout({ currency: "EUR", periods: [] }).nodes).toEqual([]);
  const zero = renderBalanceFlowSvg({ currency: "EUR", periods: [{ label: "Zero", opening: 0, inflows: [], outflows: [], closing: 0 }] });
  expect(zero).toContain(">Opening</text>");
  expect(zero).toContain(">Closing</text>");
});

test("balance-flow CSS has no red or green roles and long labels keep full inspection text", async () => {
  for (const file of ["../../styles/index.css", "../../base/base.css"]) {
    const css = await Bun.file(new URL(file, import.meta.url)).text();
    expect(css.split("/* BalanceFlow:")[1]).not.toMatch(/--[^,;)\s]*(?:red|green|success|danger)/i);
  }
  const label = "A very long marketplace order label with the original full settlement name";
  const spec = {
    ...balanceFixture,
    periods: [
      { ...balanceFixture.periods[0]!, outflows: balanceFixture.periods[0]!.outflows.map((n, i) => (i === 0 ? { ...n, label } : n)) },
    ],
  };
  const svg = renderBalanceFlowSvg({ ...spec, inspect: true });
  expect(svg).toContain(label);
  expect(svg).toContain("…");
  for (const match of svg.matchAll(/<text x="([^"]+)"[^>]*>([^<]+)<\/text>/g)) {
    expect(chartTextWidth(match[2]!, 12)).toBeLessThanOrEqual(180);
    expect(Number(match[1])).toBeLessThanOrEqual(620);
  }
});

test("custom value labels remain validated inspection metadata", () => {
  const datum = { role: "item", index: 0, anchor: [0, 0], values: [{ key: "value", value: 1, label: "Amount" }] };
  expect(isChartDatum(datum)).toBe(true);
  expect(isChartDatum({ ...datum, values: [{ key: "value", value: 1, label: 123 }] })).toBe(false);
});

test("desktop captions label every bar without overlap, including clustered small deductions", () => {
  const scene = balanceFlowLayout(balanceFixture);
  expect(scene.nodes.filter((n) => n.showLabel)).toHaveLength(scene.nodes.length);
  for (const stage of [0, 1, 2]) {
    const labels = scene.nodes
      .filter((n) => n.stage === stage && n.showLabel)
      .map((n) => scene.labelY.get(n.index)!)
      .sort((a, b) => a - b);
    for (let i = 1; i < labels.length; i++) expect(labels[i]! - labels[i - 1]!).toBeGreaterThanOrEqual(36);
    for (const y of labels) {
      expect(y - 15).toBeGreaterThanOrEqual(scene.header.height);
      expect(y + 14).toBeLessThanOrEqual(scene.height);
    }
  }
  const svg = renderBalanceFlowSvg({ ...balanceFixture, inspect: true });
  expect(svg.match(/class="k2b-balance-flow-caption"/g)).toHaveLength(
    balanceFixture.periods.reduce(
      (total, _, period) => total + balanceFlowLayout({ ...balanceFixture, period }).nodes.filter((n) => n.showLabel).length,
      0,
    ),
  );
  expect(svg).toContain(">Refunds</text>");
  expect(svg).toContain(">Shipping labels</text>");
});

test("invalid frame names the offending month, even when it is not the active period", () => {
  const spec = { ...balanceFixture, periods: balanceFixture.periods.map((p, i) => (i === 1 ? { ...p, closing: p.closing + 1 } : p)) };
  try {
    validateBalanceFlow(spec.periods);
    throw new Error("Expected invalid ledger");
  } catch (error) {
    expect(error).toBeInstanceOf(BalanceFlowError);
    expect(error).toMatchObject({ period: 1, periodLabel: spec.periods[1]!.label });
  }
  expect(renderBalanceFlowHtml({ ...spec, locale: "de" })).toContain(`${spec.periods[1]!.label}: Die Beträge gehen nicht auf`);
});
