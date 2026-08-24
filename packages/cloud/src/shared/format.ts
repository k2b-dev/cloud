/**
 * Presentation formatting shared across Cloud surfaces.
 *
 * These existed as ~30 local copies that disagreed with each other: the same
 * count rendered as `1.234.567`, `1,234,567` and `1234.6k` on adjacent pages,
 * the same duration as `90.00s` and `2m`, and seven hand-written date
 * formatters hardcoded `de-DE`, so the viewer's configured locale and timezone
 * were ignored outright.
 *
 * Everything here now delegates to `@k2b/stdlib`, which owns the
 * number, percent, duration, byte and date formatting. This module stays as
 * the Cloud-facing surface for two reasons: it keeps the import site stable
 * for the pages that already use it, and it adds the couple of conveniences
 * that are Cloud's rather than stdlib's — a part-of-total ratio, and date
 * helpers that treat an absent value as absent instead of throwing.
 *
 * Prefer `text.pprint*` directly in new code that has no null handling to do.
 */
import { type DateContext, dates, text } from "@k2b/stdlib";

/** Shown where a value is genuinely absent, as opposed to zero. */
export const EMPTY_VALUE = "—";

export type FormatOptions = {
  /** Rendered when the value is null, undefined or not finite. */
  fallback?: string;
  locale?: string;
};

/**
 * Grouped count. `compact` switches to `1.2k` / `3.4M` for dense surfaces
 * where the exact figure is not the point.
 */
export const formatNumber = (
  value: number | null | undefined,
  options: FormatOptions & { compact?: boolean; decimals?: number } = {},
): string => text.pprintNumber(value, options);

/**
 * Percentage from a ratio in 0..1.
 *
 * Taking a ratio rather than an already-multiplied number is deliberate: the
 * old copies disagreed about which they expected, which is a silent factor-100
 * bug rather than a visible one.
 */
export const formatPercent = (
  ratio: number | null | undefined,
  options: FormatOptions & { decimals?: number; clamp?: boolean } = {},
): string => text.pprintPercent(ratio, { decimals: 1, ...options });

/** Share of a total, guarding the zero-total case the copies kept getting wrong. */
export const formatRatio = (
  part: number | null | undefined,
  total: number | null | undefined,
  options: FormatOptions & { decimals?: number } = {},
): string =>
  typeof part !== "number" || typeof total !== "number" || !Number.isFinite(part) || !Number.isFinite(total) || total === 0
    ? (options.fallback ?? EMPTY_VALUE)
    : formatPercent(part / total, options);

/**
 * Duration from a measured millisecond count.
 *
 * Distinct from `dates.formatDuration`, which takes two timestamps: a span's
 * `durationMs`, a request latency or a timeout budget never had timestamps to
 * subtract.
 */
export const formatDurationMs = (ms: number | null | undefined, options: FormatOptions = {}): string => text.pprintDurationMs(ms, options);

/** Byte size. Defaults to SI because storage tooling reports GB, not GiB. */
export const formatBytes = (bytes: number | null | undefined, options: FormatOptions & { mode?: "iec" | "si" } = {}): string =>
  typeof bytes === "number" && Number.isFinite(bytes)
    ? text.pprintBytes(bytes, { mode: options.mode ?? "si", locale: options.locale })
    : (options.fallback ?? EMPTY_VALUE);

/**
 * Absolute date and time in the viewer's locale and timezone.
 *
 * Pass the request's `DateContext` from `getDateConfig(c)`; without it stdlib
 * falls back to the host settings, which is what the hardcoded `de-DE`
 * formatters did permanently.
 */
export const formatDateTime = (value: string | Date | null | undefined, context?: DateContext, options: FormatOptions = {}): string =>
  value === null || value === undefined ? (options.fallback ?? EMPTY_VALUE) : dates.formatDateTime(value, context);

export const formatDate = (value: string | Date | null | undefined, context?: DateContext, options: FormatOptions = {}): string =>
  value === null || value === undefined ? (options.fallback ?? EMPTY_VALUE) : dates.formatDate(value, context);

/** Relative time such as "3 minutes ago", for freshness rather than record-keeping. */
export const formatRelative = (value: string | Date | null | undefined, context?: DateContext, options: FormatOptions = {}): string =>
  value === null || value === undefined ? (options.fallback ?? EMPTY_VALUE) : dates.formatTimeSpan(value, context);
