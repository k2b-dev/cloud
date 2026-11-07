import type { JsonValue } from "./examples/types";

/** A portable number format (`{ style, currency, unit, decimals, compact }`) as text, in the page's locale. */
export function formatNumber(value: number, format: JsonValue | undefined, locale = "en"): string {
  const options = format !== null && typeof format === "object" && !Array.isArray(format) ? format : {};
  const style = options.style === "percent" || options.style === "currency" ? options.style : "decimal";
  const decimals = typeof options.decimals === "number" ? options.decimals : undefined;
  const text = new Intl.NumberFormat(locale, {
    style,
    ...(style === "currency" && typeof options.currency === "string" ? { currency: options.currency } : {}),
    ...(options.compact === true ? { notation: "compact" as const } : {}),
    ...(decimals === undefined
      ? { maximumFractionDigits: style === "percent" ? 1 : 2 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  }).format(value);
  return typeof options.unit === "string" ? `${text} ${options.unit}` : text;
}
