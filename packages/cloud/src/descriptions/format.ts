import { formatBytes } from "../shared/format";
import type { DescriptionJson } from "./json";

/**
 * A portable number format (`{ style, currency, unit, decimals, compact }`) as text in the given locale. A count in the
 * unit `B` reads as a size, as everywhere in Cloud: 2,4 MB rather than 2.400.000 B.
 */
export function formatDescriptionNumber(value: number, format: DescriptionJson | undefined, locale: string): string {
  const options = format !== null && typeof format === "object" && !Array.isArray(format) ? format : {};
  const style = options.style === "percent" || options.style === "currency" ? options.style : "decimal";
  if (options.unit === "B" && style === "decimal") return formatBytes(value, { locale });
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
