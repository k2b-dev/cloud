import type { DateContext } from "@k2b/stdlib";
import Decimal from "decimal.js";
import type { CustomAppValueFormat } from "../../custom-apps/contracts";

const ValueDecimal = Decimal.clone({ precision: 80 });
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const numericText = (value: unknown): string | null => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DECIMAL_TEXT.test(trimmed) ? trimmed : null;
};

const fractionDigits = (format: CustomAppValueFormat | undefined) => {
  if (format?.style === "integer") return { minimumFractionDigits: 0, maximumFractionDigits: 0 };
  if (format?.decimalPlaces !== undefined) {
    return { minimumFractionDigits: format.decimalPlaces, maximumFractionDigits: format.decimalPlaces };
  }
  return format?.style === "percent"
    ? { minimumFractionDigits: 0, maximumFractionDigits: 1 }
    : { minimumFractionDigits: 0, maximumFractionDigits: 4 };
};

export const formatCustomAppValue = (
  value: unknown,
  format: CustomAppValueFormat | undefined,
  dateConfig?: Pick<DateContext, "locale">,
): string => {
  if (value === null || value === undefined) return "—";
  const raw = numericText(value);
  if (raw === null) return String(value);
  const style = format?.style ?? "number";
  const mathematicalValue = style === "integer" ? new ValueDecimal(raw).toDecimalPlaces(0, Decimal.ROUND_HALF_CEIL).toFixed(0) : raw;
  const formatted = new Intl.NumberFormat(dateConfig?.locale ?? "en", {
    ...(style === "percent" ? { style: "percent" as const } : {}),
    ...fractionDigits(format),
  }).format(mathematicalValue as `${number}`);
  if (!format?.unit) return formatted;
  return format.unitPosition === "prefix" ? `${format.unit} ${formatted}` : `${formatted} ${format.unit}`;
};
