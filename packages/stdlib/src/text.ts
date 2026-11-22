// ==========================
// Text Manipulation Utilities
// ==========================

/**
 * Convert a string to a URL-friendly slug.
 *
 * Processing pipeline:
 * 1. NFKD normalization -- decomposes characters like "u" into base + combining mark.
 * 2. Strip combining diacritical marks (`U+0300`-`U+036F`).
 * 3. Lowercase.
 * 4. Trim whitespace.
 * 5. Replace non-alphanumeric runs with a single hyphen.
 * 6. Strip leading/trailing hyphens.
 *
 * An empty input string produces an empty output string.
 *
 * @param content - The string to slugify.
 * @returns A URL-safe slug (lowercase, hyphen-separated).
 *
 * @example text.slugify("Hello World!")   // "hello-world"
 * @example text.slugify("Uber uns")       // "uber-uns"
 * @example text.slugify("")               // ""
 * @example text.slugify("---")            // ""
 */
export const slugify = (content: string): string =>
  content
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Convert a string to human-readable format.
 *
 * Strips leading/trailing underscores and whitespace, collapses runs of
 * underscores, hyphens, and spaces into single spaces, then capitalizes
 * the first letter of the result.
 *
 * @param content - The string to humanize (e.g. a slug or variable name).
 * @returns A human-readable string with the first letter uppercased.
 *
 * @example text.humanize("hello_world-foo") // "Hello world foo"
 * @example text.humanize("_leading_")       // "Leading"
 */
export const humanize = (content: string): string =>
  content
    .replace(/^[\s_]+|[\s_]+$/g, "")
    .replace(/[_\s]+/g, " ")
    .replace(/[-\s]+/g, " ")
    .replace(/^[a-z]/, (m) => m.toUpperCase());

/**
 * Convert a string to title case by capitalizing the first letter of each word.
 *
 * Internally delegates to {@link humanize} first, so underscores, hyphens,
 * and extra whitespace are cleaned up before title-casing.
 *
 * @param content - The string to convert to title case.
 * @returns A title-cased string.
 *
 * @example text.titleify("hello world foo")   // "Hello World Foo"
 * @example text.titleify("hello_world-foo")   // "Hello World Foo"
 */
export const titleify = (content: string): string => {
  const humanized = humanize(content);
  return humanized
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

export type PprintNumberOptions = {
  /** Use deterministic decimal suffixes (`k`, `M`, `B`, `T`). Default false. */
  compact?: boolean;
  /** Fixed fraction digits, normalized to an integer from 0 to 20. */
  decimals?: number;
  /** Number-format locale. Defaults to the runtime locale. */
  locale?: string;
  /** Returned for null, undefined, NaN, or Infinity. Default `"—"`. */
  fallback?: string;
};

export type PprintPercentOptions = {
  /** Fixed fraction digits, normalized to an integer from 0 to 20. Default 0. */
  decimals?: number;
  /** Clamp the input ratio to 0..1 before formatting. Default false. */
  clamp?: boolean;
  /** Number-format locale. Defaults to the runtime locale. */
  locale?: string;
  /** Returned for null, undefined, NaN, or Infinity. Default `"—"`. */
  fallback?: string;
};

export type PprintDurationMsOptions = {
  /** Number-format locale. Defaults to the runtime locale. */
  locale?: string;
  /** Returned for null, undefined, negative, NaN, or Infinity. Default `"—"`. */
  fallback?: string;
};

const DEFAULT_PPRINT_FALLBACK = "—";
const MAX_PPRINT_DECIMALS = 20;

const normalizePprintDecimals = (decimals: number | undefined, fallback: number): number => {
  if (!Number.isFinite(decimals)) return fallback;
  return Math.max(0, Math.min(MAX_PPRINT_DECIMALS, Math.trunc(decimals!)));
};

const exactFractionDigits = (decimals: number | undefined) =>
  decimals === undefined
    ? {}
    : {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      };

const formatLocalizedNumber = (
  value: number,
  options: {
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    useGrouping?: boolean;
  },
): string =>
  new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
    useGrouping: options.useGrouping,
  }).format(Object.is(value, -0) ? 0 : value);

const COMPACT_NUMBER_UNITS = [
  { threshold: 1_000, suffix: "k" },
  { threshold: 1_000_000, suffix: "M" },
  { threshold: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000_000_000, suffix: "T" },
] as const;

const compactUnitIndexFor = (value: number): number => {
  const absolute = Math.abs(value);
  for (let index = COMPACT_NUMBER_UNITS.length - 1; index >= 0; index--) {
    if (absolute >= COMPACT_NUMBER_UNITS[index]!.threshold) return index;
  }
  return -1;
};

const formatCompactNumber = (
  value: number,
  unitIndex: number,
  decimals: number | undefined,
  locale: string | undefined,
): string => {
  const compactDecimals = decimals ?? 1;
  const roundingFactor = 10 ** compactDecimals;
  const unit = COMPACT_NUMBER_UNITS[unitIndex]!;
  const roundedAbsolute =
    Math.round((Math.abs(value) / unit.threshold + Number.EPSILON) * roundingFactor) /
    roundingFactor;
  const selectedIndex =
    roundedAbsolute >= 1_000 && unitIndex < COMPACT_NUMBER_UNITS.length - 1
      ? unitIndex + 1
      : unitIndex;
  const selectedUnit = COMPACT_NUMBER_UNITS[selectedIndex]!;
  return `${formatLocalizedNumber(value / selectedUnit.threshold, {
    locale,
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: compactDecimals,
    useGrouping: false,
  })}${selectedUnit.suffix}`;
};

/**
 * Format a finite number with locale-aware grouping and optional compact units.
 *
 * Compact suffixes are deterministic across locales; only the numeric part is
 * localized. Explicit `decimals` are fixed, while compact output otherwise
 * uses up to one fraction digit.
 *
 * @example text.pprintNumber(1234567, { locale: "en-US" })                 // "1,234,567"
 * @example text.pprintNumber(1234567, { compact: true, locale: "en-US" })  // "1.2M"
 * @example text.pprintNumber(1234, { compact: true, locale: "de-DE" })     // "1,2k"
 */
export const pprintNumber = (
  value: number | null | undefined,
  options: PprintNumberOptions = {},
): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.fallback ?? DEFAULT_PPRINT_FALLBACK;
  }

  const hasExplicitDecimals = options.decimals !== undefined;
  const decimals = hasExplicitDecimals
    ? normalizePprintDecimals(options.decimals, 0)
    : undefined;
  const compactUnitIndex = options.compact ? compactUnitIndexFor(value) : -1;

  if (compactUnitIndex < 0) {
    return formatLocalizedNumber(value, {
      locale: options.locale,
      ...exactFractionDigits(decimals),
    });
  }
  return formatCompactNumber(value, compactUnitIndex, decimals, options.locale);
};

/**
 * Format a ratio as a percentage.
 *
 * The input is always a ratio: `0.12` renders as `12%`. This function never
 * accepts an already multiplied percentage scale.
 *
 * @example text.pprintPercent(0.1234, { locale: "en-US" })                // "12%"
 * @example text.pprintPercent(0.999, { decimals: 3, locale: "en-US" })    // "99.900%"
 * @example text.pprintPercent(1.4, { clamp: true, locale: "en-US" })      // "100%"
 */
export const pprintPercent = (
  ratio: number | null | undefined,
  options: PprintPercentOptions = {},
): string => {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return options.fallback ?? DEFAULT_PPRINT_FALLBACK;
  }

  const decimals = normalizePprintDecimals(options.decimals, 0);
  const normalizedRatio = options.clamp
    ? Math.max(0, Math.min(1, ratio))
    : ratio;
  const percentage = normalizedRatio * 100;
  if (!Number.isFinite(percentage)) {
    return options.fallback ?? DEFAULT_PPRINT_FALLBACK;
  }
  const value = formatLocalizedNumber(percentage, {
    locale: options.locale,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${value}%`;
};

const formatDurationParts = (totalSeconds: number, locale: string | undefined): string => {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    { value: days, unit: "d" },
    { value: hours, unit: "h" },
    { value: minutes, unit: "m" },
    { value: seconds, unit: "s" },
  ]
    .filter((part) => part.value > 0)
    .slice(0, 2)
    .map(
      (part) =>
        `${formatLocalizedNumber(part.value, {
          locale,
          maximumFractionDigits: 0,
        })}${part.unit}`,
    )
    .join(" ");
};

const formatSubsecondDuration = (
  milliseconds: number,
  locale: string | undefined,
): string => {
  const roundedMilliseconds = Math.round(milliseconds);
  return roundedMilliseconds >= 1_000
    ? "1s"
    : `${formatLocalizedNumber(roundedMilliseconds, {
        locale,
        maximumFractionDigits: 0,
      })}ms`;
};

const formatSecondsDuration = (
  milliseconds: number,
  locale: string | undefined,
): string => {
  const seconds = milliseconds / 1_000;
  const decimals = seconds < 10 ? 2 : 1;
  const roundingFactor = 10 ** decimals;
  const roundedSeconds =
    Math.round((seconds + Number.EPSILON) * roundingFactor) / roundingFactor;
  return roundedSeconds >= 60
    ? formatDurationParts(60, locale)
    : `${formatLocalizedNumber(roundedSeconds, {
        locale,
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
        useGrouping: false,
      })}s`;
};

/**
 * Format a raw millisecond duration with a deterministic short-unit ladder.
 *
 * Invalid and negative durations return `fallback`. Durations of at least one
 * minute are rounded to whole seconds and rendered with at most two non-zero
 * units.
 *
 * @example text.pprintDurationMs(0.4)       // "<1ms"
 * @example text.pprintDurationMs(1234)      // "1.23s"
 * @example text.pprintDurationMs(90_000)    // "1m 30s"
 * @example text.pprintDurationMs(7_200_000) // "2h"
 */
export const pprintDurationMs = (
  milliseconds: number | null | undefined,
  options: PprintDurationMsOptions = {},
): string => {
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    return options.fallback ?? DEFAULT_PPRINT_FALLBACK;
  }
  if (milliseconds === 0) return "0ms";
  if (milliseconds < 1) return "<1ms";
  if (milliseconds < 1_000) return formatSubsecondDuration(milliseconds, options.locale);
  if (milliseconds < 60_000) return formatSecondsDuration(milliseconds, options.locale);

  return formatDurationParts(
    Math.round(milliseconds / 1_000),
    options.locale,
  );
};

/**
 * Mode for byte size formatting.
 *
 * - `"iec"` -- binary (1 KiB = 1024 B), units: B, KiB, MiB, GiB, TiB, PiB.
 * - `"si"`  -- decimal (1 KB = 1000 B), units: B, KB, MB, GB, TB, PB.
 */
export type ByteMode = "iec" | "si";

const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
const SI_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export type PprintBytesOptions = {
  /** `"iec"` (default, 1024-base) or `"si"` (1000-base). */
  mode?: ByteMode;
  /** Number-format locale. Defaults to the runtime locale. */
  locale?: string;
};

/**
 * Split a byte count into a localized numeric string and its unit.
 *
 * Useful when you want to render the value and unit with different styles
 * (e.g. a large number next to a small unit label).
 *
 * Decimal places are picked for readability: 0 when the value >= 100,
 * 1 when >= 10, and 2 otherwise. Raw bytes (exponent 0) are integer-formatted.
 *
 * Only the numeric part is localized (`"1,5"` for German, `"1.5"` for
 * English); the byte units themselves are international. Thousands grouping
 * is disabled to avoid `"1.023 B"`-style ambiguity in locales that use `.`
 * as the grouping separator.
 *
 * Guards against `Infinity`, `NaN`, and non-positive values by returning
 * `{ value: "0", unit: "B" }`.
 *
 * @example text.pprintBytesParts(1536)                    // { value: "1.5", unit: "KiB" }
 * @example text.pprintBytesParts(1500, { mode: "si" })    // { value: "1.5", unit: "KB"  }
 * @example text.pprintBytesParts(1536, { locale: "de" })  // { value: "1,5", unit: "KiB" }
 */
export const pprintBytesParts = (
  bytes: number,
  options: PprintBytesOptions = {},
): { value: string; unit: string } => {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0", unit: "B" };

  const units = options.mode === "si" ? SI_UNITS : IEC_UNITS;
  const base = options.mode === "si" ? 1000 : 1024;

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(base)),
    units.length - 1,
  );
  const unit = units[exponent]!;
  const value = bytes / Math.pow(base, exponent);

  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;

  const formatted = new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(value);

  return { value: formatted, unit };
};

/**
 * Pretty-print a byte count as a human-readable string.
 *
 * Defaults to IEC binary units (1 KiB = 1024 B). Pass `mode: "si"` for
 * decimal units (1 KB = 1000 B). See {@link pprintBytesParts} for a variant
 * that returns value and unit separately for styled rendering.
 *
 * @example text.pprintBytes(0)                       // "0 B"
 * @example text.pprintBytes(1536)                    // "1.5 KiB"
 * @example text.pprintBytes(1500, { mode: "si" })    // "1.5 KB"
 * @example text.pprintBytes(1536, { locale: "de" })  // "1,5 KiB"
 */
export const pprintBytes = (bytes: number, options: PprintBytesOptions = {}): string => {
  const { value, unit } = pprintBytesParts(bytes, options);
  return `${value} ${unit}`;
};

export type PprintCurrencyOptions = {
  /** Fixed fraction digits. Defaults to the currency's standard digits. */
  decimals?: number;
  /** Number-format locale. Defaults to the runtime locale. */
  locale?: string;
  /** Returned for null, undefined, NaN, or Infinity. Default `"—"`. */
  fallback?: string;
};

/**
 * Format an amount as a localized currency string via `Intl.NumberFormat`.
 *
 * The currency is an ISO 4217 code (`"EUR"`, `"USD"`, ...). Symbol choice,
 * placement, and fraction digits follow the locale and currency conventions.
 *
 * @example text.pprintCurrency(1234.5, "EUR", { locale: "de" })     // "1.234,50 €"
 * @example text.pprintCurrency(1234.5, "USD", { locale: "en-US" })  // "$1,234.50"
 * @example text.pprintCurrency(null, "EUR")                        // "—"
 */
export const pprintCurrency = (
  value: number | null | undefined,
  currency: string,
  options: PprintCurrencyOptions = {},
): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.fallback ?? DEFAULT_PPRINT_FALLBACK;
  }
  const decimals =
    options.decimals === undefined ? undefined : normalizePprintDecimals(options.decimals, 0);
  return new Intl.NumberFormat(options.locale, {
    style: "currency",
    currency,
    ...exactFractionDigits(decimals),
  }).format(Object.is(value, -0) ? 0 : value);
};

/**
 * Split any string into lowercase words, handling camelCase, PascalCase,
 * snake_case, kebab-case, and space-separated inputs.
 *
 * @param content - The string to split into words.
 * @returns An array of lowercase words.
 */
const splitWords = (content: string): string[] =>
  content
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * Truncate a string to a maximum length, adding an ellipsis character.
 *
 * In `"end"` mode (the default) the ellipsis replaces the tail of the string.
 * In `"middle"` mode the ellipsis is placed in the centre so that the
 * beginning and end of the original string are preserved.
 *
 * The limit includes the ellipsis character itself.  If the content already
 * fits within the limit it is returned unchanged.
 *
 * @param content - The string to truncate.
 * @param limit   - Maximum allowed length (including the ellipsis).
 * @param mode    - `"end"` (default) or `"middle"`.
 * @returns The (possibly truncated) string.
 *
 * @example text.truncate("Hello World", 6)            // "Hello…"
 * @example text.truncate("Hello World", 6, "middle")  // "He…ld"
 */
export const truncate = (
  content: string,
  limit: number,
  mode: "end" | "middle" = "end",
): string => {
  if (content.length <= limit) return content;
  if (mode === "middle") {
    const half = Math.floor((limit - 1) / 2);
    return content.slice(0, half) + "…" + content.slice(-(limit - 1 - half));
  }
  return content.slice(0, limit - 1) + "…";
};

/**
 * Truncate a string like {@link truncate}, then append a human-readable
 * `[N chars omitted]` suffix so the reader knows how much was removed.
 *
 * The omitted-info suffix is **not** counted toward the limit.
 *
 * @param content - The string to summarize.
 * @param limit   - Maximum allowed length for the visible part (including ellipsis).
 * @param mode    - `"end"` (default) or `"middle"`.
 * @returns The truncated string followed by ` [N chars omitted]`, or the
 *          original string if it already fits.
 *
 * @example text.summarize("Hello World", 6)  // "Hello… [6 chars omitted]"
 */
export const summarize = (
  content: string,
  limit: number,
  mode: "end" | "middle" = "end",
): string => {
  if (content.length <= limit) return content;
  const omitted = content.length - limit + 1;
  const truncated = truncate(content, limit, mode);
  return `${truncated} [${omitted} chars omitted]`;
};

/**
 * Convert a string to camelCase.
 *
 * Handles camelCase, PascalCase, snake_case, kebab-case, and
 * space-separated inputs.
 *
 * @param content - The string to convert.
 * @returns The camelCased string.
 *
 * @example text.camelCase("hello world")  // "helloWorld"
 * @example text.camelCase("HelloWorld")   // "helloWorld"
 */
export const camelCase = (content: string): string => {
  const words = splitWords(content);
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
};

/**
 * Convert a string to PascalCase.
 *
 * Handles camelCase, PascalCase, snake_case, kebab-case, and
 * space-separated inputs.
 *
 * @param content - The string to convert.
 * @returns The PascalCased string.
 *
 * @example text.pascalCase("hello world")  // "HelloWorld"
 * @example text.pascalCase("hello_world")  // "HelloWorld"
 */
export const pascalCase = (content: string): string =>
  splitWords(content)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/**
 * Convert a string to snake_case.
 *
 * Handles camelCase, PascalCase, snake_case, kebab-case, and
 * space-separated inputs.
 *
 * @param content - The string to convert.
 * @returns The snake_cased string.
 *
 * @example text.snakeCase("hello world")  // "hello_world"
 * @example text.snakeCase("helloWorld")   // "hello_world"
 */
export const snakeCase = (content: string): string =>
  splitWords(content).join("_");

/**
 * Convert a string to kebab-case.
 *
 * Handles camelCase, PascalCase, snake_case, kebab-case, and
 * space-separated inputs.
 *
 * @param content - The string to convert.
 * @returns The kebab-cased string.
 *
 * @example text.kebabCase("hello world")  // "hello-world"
 * @example text.kebabCase("hello_world")  // "hello-world"
 */
export const kebabCase = (content: string): string =>
  splitWords(content).join("-");

export const text = {
  slugify,
  humanize,
  titleify,
  pprintNumber,
  pprintPercent,
  pprintDurationMs,
  pprintBytes,
  pprintBytesParts,
  pprintCurrency,
  truncate,
  summarize,
  camelCase,
  pascalCase,
  snakeCase,
  kebabCase,
} as const;
