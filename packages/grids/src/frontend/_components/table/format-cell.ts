import { type DateContext, dates } from "@k2b/stdlib";
import Decimal from "decimal.js";
import type { FormatSpec } from "../../../contracts";
import { tableMessages } from "./messages";

/**
 * Renders a single field value to its display string. Type-aware:
 *  - boolean → locale-aware yes / no labels
 *  - select   → option labels, not ids
 *  - number with unit → "<amount> <unit>" or "<unit> <amount>"
 *  - duration → HH:MM:SS
 *  - object   → JSON-stringify fallback
 *
 * `format` overrides take precedence for date / decimal / percent.
 * Mismatches (e.g. a date format on a text field) are silently
 * ignored — the renderer falls back to the type-default rendering.
 *
 * Relation values are NOT handled here — they need a label cache from
 * the SSR layer, see DatabaseTable / RecordDetailPanel.
 */
export const formatCell = (
  value: unknown,
  type: string,
  fieldConfig?: Record<string, unknown>,
  format?: FormatSpec,
  dateConfig?: DateContext,
  locale = dateConfig?.locale ?? "en",
): string => {
  if (value === null || value === undefined || value === "") return "";

  const override = format ? formatOverride(value, type, format, dateConfig, locale) : null;
  if (override !== null) return override;

  // ── Type-default rendering ──────────────────────────────────────
  const renderer = DEFAULT_RENDERERS[type];
  if (renderer) return renderer(value, fieldConfig ?? {}, dateConfig, locale);

  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

type CellRenderer = (value: unknown, fieldConfig: Record<string, unknown>, dateConfig: DateContext | undefined, locale: string) => string;

const formatOverride = (
  value: unknown,
  type: string,
  format: FormatSpec,
  dateConfig: DateContext | undefined,
  locale: string,
): string | null => {
  if (format.kind === "date" && canUseDateFormat(type, value)) return formatDate(value, format, dateConfig, locale);
  if (format.kind === "decimal" && canUseDecimalFormat(type, value)) return formatDecimal(value, format, locale);
  if (format.kind === "percent" && canUsePercentFormat(type)) return formatPercent(value, format, locale);
  return null;
};

const canUseDateFormat = (type: string, value: unknown): value is string =>
  (type === "date" || type === "formula") && typeof value === "string";

const canUseDecimalFormat = (type: string, value: unknown): value is number | string =>
  (type === "number" || type === "formula") && (typeof value === "number" || typeof value === "string");

const canUsePercentFormat = (type: string): boolean => type === "percent" || type === "formula";

const DEFAULT_RENDERERS: Record<string, CellRenderer> = {
  date: (value, fieldConfig, dateConfig) =>
    typeof value === "string" ? formatDateDefault(value, fieldConfig, dateConfig) : fallbackValue(value),
  boolean: (value, _fieldConfig, _dateConfig, locale) => {
    const { t } = tableMessages.resolve([locale]);
    return value ? t.yes : t.no;
  },
  select: (value, fieldConfig) => (Array.isArray(value) ? formatSelect(value, fieldConfig) : fallbackValue(value)),
  number: (value, fieldConfig) => formatNumberDefault(value, fieldConfig),
  percent: (value) => (typeof value === "number" ? `${value}%` : fallbackValue(value)),
  duration: (value) => (typeof value === "number" ? formatDuration(value) : fallbackValue(value)),
};

const fallbackValue = (value: unknown): string => (typeof value === "object" ? JSON.stringify(value) : String(value));

const zonedDateTimeText = (value: string, dateConfig?: DateContext): string => {
  if (!dateConfig?.timeZone) return value.replace("T", " ");
  try {
    return dates.instantToZonedInput(value, dateConfig.timeZone).replace("T", " ");
  } catch {
    return value.replace("T", " ");
  }
};

const formatDateDefault = (value: string, fieldConfig: Record<string, unknown>, dateConfig?: DateContext): string =>
  fieldConfig.includeTime ? zonedDateTimeText(value, dateConfig) : value.slice(0, 10);

const formatSelect = (ids: unknown[], fieldConfig: Record<string, unknown>): string => {
  const options = (fieldConfig.options as Array<{ id: string; label: string }> | undefined) ?? [];
  const labels = new Map(options.map((o) => [o.id, o.label]));
  return ids.map((id) => labels.get(String(id)) ?? String(id)).join(", ");
};

const formatNumberDefault = (value: unknown, fieldConfig: Record<string, unknown>): string => {
  const unit = typeof fieldConfig.unit === "string" ? fieldConfig.unit : "";
  const unitPosition = fieldConfig.unitPosition === "prefix" ? "prefix" : "suffix";
  const amount =
    typeof value === "object" && value !== null && "amount" in value
      ? (value as { amount?: string | number }).amount
      : (value as string | number);
  return formatWithUnit(amount, unit, unitPosition);
};

const formatDuration = (value: number): string => {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

// ─── format-spec implementations ─────────────────────────────────

const formatDate = (
  iso: string,
  spec: Extract<FormatSpec, { kind: "date" }>,
  dateConfig: DateContext | undefined,
  locale: string,
): string => {
  if (spec.format === "iso") {
    return spec.includeTime ? zonedDateTimeText(iso, dateConfig) : iso.slice(0, 10);
  }
  const d = new Date(spec.includeTime ? iso : `${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const timeZone = spec.includeTime ? dateConfig?.timeZone : "UTC";
  if (spec.format === "relative") {
    const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
    if (days > -30 && days < 30) return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(-days, "day");
    return d.toLocaleDateString(locale, timeZone ? { timeZone } : undefined);
  }
  if (spec.format === "long") {
    return d.toLocaleDateString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      ...(timeZone && { timeZone }),
      ...(spec.includeTime && { hour: "2-digit", minute: "2-digit" }),
    });
  }
  // short — locale-aware
  return spec.includeTime
    ? d.toLocaleString(locale, timeZone ? { timeZone } : undefined)
    : d.toLocaleDateString(locale, timeZone ? { timeZone } : undefined);
};

const numberSymbols = (locale: string): { decimal: string; group: string } => {
  const parts = new Intl.NumberFormat(locale).formatToParts(1000.1);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? ",",
  };
};

const localizeFixedDecimal = (fixed: string, locale: string, grouped: boolean): string => {
  const { decimal, group } = numberSymbols(locale);
  const [integer = "", fraction] = fixed.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const digits = sign ? integer.slice(1) : integer;
  const localizedInteger = grouped ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, group) : digits;
  return `${sign}${localizedInteger}${fraction === undefined ? "" : `${decimal}${fraction}`}`;
};

const formatDecimal = (v: number | string, spec: Extract<FormatSpec, { kind: "decimal" }>, locale: string): string => {
  let dec: Decimal;
  try {
    dec = new Decimal(typeof v === "number" ? String(v) : v);
  } catch {
    return String(v);
  }
  if (!dec.isFinite()) return String(v);
  const fixed = spec.precision !== undefined ? dec.toFixed(spec.precision) : dec.toFixed();
  return localizeFixedDecimal(fixed, locale, spec.thousandsSeparator === true);
};

const formatPercent = (value: unknown, spec: Extract<FormatSpec, { kind: "percent" }>, locale: string): string => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return String(value);
  const fixed = spec.precision !== undefined ? n.toFixed(spec.precision) : String(n);
  return `${localizeFixedDecimal(fixed, locale, false)}%`;
};

export const progressRatio = (value: unknown, type: string, fieldConfig?: Record<string, unknown>): number => {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  const n = Number.isFinite(raw) ? raw : 0;
  const ratio = type === "percent" && fieldConfig?.range !== "fraction" ? n / 100 : n;
  return Math.max(0, Math.min(1, ratio));
};

/**
 * Render a decimal amount with a free-text unit. The amount is the
 * stored decimal (`"12.34"` string or `12.34` number); the unit is
 * whatever the field admin typed in field config ("EUR", "kg", "%",
 * "credits", …) — purely display, no semantics.
 */
const formatWithUnit = (amount: string | number | null | undefined, unit: string, position: "prefix" | "suffix"): string => {
  if (amount === null || amount === undefined || amount === "") return "";
  const text = String(amount);
  if (!unit) return text;
  return position === "prefix" ? `${unit} ${text}` : `${text} ${unit}`;
};
