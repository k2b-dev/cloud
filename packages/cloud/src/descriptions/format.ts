import { text as stdText } from "@k2b/stdlib";
import { formatBytes } from "../shared/format";
import type { DescriptionJson } from "./json";

type NumberFormat = { [key: string]: DescriptionJson };

const formatOptions = (format: DescriptionJson | undefined): NumberFormat =>
  format !== null && typeof format === "object" && !Array.isArray(format) ? format : {};

/** The size units `formatBytes` picks from, in order: SI, as storage tooling reports them. */
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * A size of at least one byte, signed, in the locale's minus sign. The amount is formatted on its own because the
 * shared byte formatter reads every amount below one byte as 0 B and has no fixed number of decimals.
 */
const formatSize = (value: number, decimals: number | undefined, locale: string): string => {
  const size = Math.abs(value);
  let amount = formatBytes(size, { locale });
  if (decimals !== undefined) {
    const { unit } = stdText.pprintBytesParts(size, { mode: "si", locale });
    const scaled = size / 1000 ** SIZE_UNITS.indexOf(unit);
    amount = `${new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false }).format(scaled)} ${unit}`;
  }
  if (value >= 0) return amount;
  const minus = new Intl.NumberFormat(locale).formatToParts(-1).find((part) => part.type === "minusSign")?.value ?? "-";
  return `${minus}${amount}`;
};

/**
 * A portable number format (`{ style, currency, unit, decimals, compact }`) as text in the given locale. A count in the
 * unit `B` of at least one byte reads as a size, as everywhere in Cloud: 2,4 MB rather than 2.400.000 B; `decimals`
 * fixes its digits too. A smaller count keeps the unit as written, such as 0,5 B.
 */
export function formatDescriptionNumber(value: number, format: DescriptionJson | undefined, locale: string): string {
  const options = formatOptions(format);
  const style = options.style === "percent" || options.style === "currency" ? options.style : "decimal";
  const decimals = typeof options.decimals === "number" ? options.decimals : undefined;
  if (options.unit === "B" && style === "decimal" && Number.isFinite(value) && Math.abs(value) >= 1)
    return formatSize(value, decimals, locale);
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

/** The most fraction digits a change is shown with before two values that differ are left to read alike. */
const MAX_CHANGE_DECIMALS = 20;

/**
 * A changed number, before and after, in one format. When the two differ but read alike, such as 2,4 MB and 2,4 MB,
 * both get more digits until the change shows, so an approval never hides what it changes.
 */
export function formatDescriptionChange(
  before: number,
  value: number,
  format: DescriptionJson | undefined,
  locale: string,
): [before: string, value: string] {
  const options = formatOptions(format);
  let pair: [string, string] = [formatDescriptionNumber(before, options, locale), formatDescriptionNumber(value, options, locale)];
  const start = typeof options.decimals === "number" ? options.decimals : 0;
  for (let decimals = start + 1; before !== value && pair[0] === pair[1] && decimals <= MAX_CHANGE_DECIMALS; decimals += 1)
    pair = [
      formatDescriptionNumber(before, { ...options, decimals }, locale),
      formatDescriptionNumber(value, { ...options, decimals }, locale),
    ];
  return pair;
}
