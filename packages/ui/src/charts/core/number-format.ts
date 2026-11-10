import type { ChartInput, ChartNumberFormat } from "../description";
import type { BalanceFlowOptions } from "./balance-flow-data";

type BalanceFlowInput = Extract<ChartInput, { kind: "balanceFlow" }>;
export type ChartRenderSettings = {
  width?: number;
  legend?: "svg" | "outside";
  formats?: { x?: (v: number) => string; y?: (v: number) => string; value?: (v: number) => string };
};
/**
 * Value precision and tick precision share the same style and units; ticks must remain distinct. A currency without
 * `decimals` or compact notation writes cents only when one of the formatted `values` has them: 418,000 € rather than
 * 418,000.00 €.
 */
export const chartNumberFormatters = (format: ChartNumberFormat | undefined, locale: string, values?: readonly number[]) => {
  const common: Intl.NumberFormatOptions = {
    style: format?.style === "number" ? "decimal" : format?.style,
    currency: format?.currency,
  };
  // Compact notation keeps its fraction: 1.2K and 1.4K must not both read 1K.
  const decimals =
    format?.decimals ??
    (format?.style === "currency" && !format.compact && values?.length && values.every(Number.isInteger) ? 0 : undefined);
  const value = new Intl.NumberFormat(
    locale,
    format
      ? {
          ...common,
          ...(decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
          ...(format.compact ? { notation: "compact" } : {}),
        }
      : { maximumSignificantDigits: 15 },
  );
  let tick: Intl.NumberFormat | undefined;
  const tickValue = (v: number) => {
    tick ??= new Intl.NumberFormat(locale, {
      ...common,
      notation: !format || format.compact ? "compact" : "standard",
      maximumSignificantDigits: 15,
    });
    return tick.format(v);
  };
  const unit = format?.unit ? ` ${format.unit}` : "";
  return { value: (v: number) => `${value.format(v)}${unit}`, tick: (v: number) => `${tickValue(v)}${unit}` };
};
/** BalanceFlow's formatting is loaded with its drawing, not with every app-frame prelude. */
export function balanceFlowRenderOptions(
  input: BalanceFlowInput,
  locale: string,
  options: ChartRenderSettings = {},
): BalanceFlowOptions & { kind: "balanceFlow" } {
  locale = input.locale ?? locale;
  return {
    kind: "balanceFlow",
    periods: input.periods,
    currency: input.currency,
    format:
      options.formats?.value ??
      (input.tooltip?.format
        ? chartNumberFormatters(
            input.tooltip.format,
            locale,
            input.periods.flatMap((p) => [p.opening, p.closing, ...p.inflows.map((n) => n.value), ...p.outflows.map((n) => n.value)]),
          ).value
        : undefined),
    valueLabel: input.tooltip?.label,
    locale,
    displayWidth: options.width,
  };
}
