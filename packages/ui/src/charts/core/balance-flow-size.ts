/** Portable balance-flow data. Amounts keep the decimal value supplied by the author. */
export type BalanceFlowItem = { label: string; value: number };
export type BalanceFlowPeriod = {
  label: string;
  opening: number;
  inflows: BalanceFlowItem[];
  outflows: BalanceFlowItem[];
  closing: number;
};

// Compare decimal input values exactly, including scientific notation. No currency rounding or epsilon can hide a broken ledger.
const decimal = (value: number) => {
  if (!Number.isFinite(value)) throw new RangeError("Balance flow amounts must be finite.");
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const [integer = "", fraction = ""] = mantissa.split(".");
  return { units: BigInt(integer + fraction), places: fraction.length - Number(exponent) };
};
const sumEquals = (terms: number[], expected: number) => {
  const numbers = [...terms, -expected].map(decimal);
  const places = Math.max(...numbers.map((n) => n.places));
  return numbers.reduce((total, n) => total + n.units * 10n ** BigInt(places - n.places), 0n) === 0n;
};
/** Retain the period identity across the JSON, frame and Notebook diagnostic boundaries. */
export class BalanceFlowError extends RangeError {
  constructor(
    readonly period: number,
    readonly periodLabel: string,
    message: string,
  ) {
    super(`Balance flow ${periodLabel}: ${message}`);
  }
}
export function validateBalanceFlow(periods: readonly BalanceFlowPeriod[]): void {
  for (const [index, period] of periods.entries()) {
    try {
      for (const item of [...period.inflows, ...period.outflows])
        if (!Number.isFinite(item.value) || item.value < 0) throw new RangeError("flows must be finite and nonnegative.");
      if (!sumEquals([period.opening, ...period.inflows.map((n) => n.value), ...period.outflows.map((n) => -n.value)], period.closing))
        throw new RangeError("opening + inflows − outflows must equal closing.");
      const previous = periods[index - 1];
      if (previous && !sumEquals([previous.closing], period.opening))
        throw new RangeError("opening must equal the previous period's closing.");
      // Finite individual numbers can still overflow a Sankey total.
      if (
        !Number.isFinite(
          Math.abs(period.opening) + Math.abs(period.closing) + [...period.inflows, ...period.outflows].reduce((s, n) => s + n.value, 0),
        )
      )
        throw new RangeError("totals must be finite.");
    } catch (error) {
      throw new BalanceFlowError(index, period.label, error instanceof Error ? error.message : "Invalid amounts.");
    }
  }
}
/** One content height for every period and state, independent of the selected month and measured browser width. */
export const balanceFlowHeight = (periods: readonly BalanceFlowPeriod[], height = 280): number =>
  Math.max(height, 64 + Math.max(1, ...periods.map((p) => Math.max(p.inflows.length, p.outflows.length))) * 36);
