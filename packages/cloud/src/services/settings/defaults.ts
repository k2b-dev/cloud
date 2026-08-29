/**
 * Central settings registry.
 * Single source of truth for configurable settings, their value kinds, defaults,
 * validation, UI metadata, and temporary env bootstrap behavior.
 *
 * Resolution order: DB value -> env fallback -> code default.
 *
 * `SettingKind` and `SettingOption` are re-exported from `contracts/shared` to
 * keep a single source of truth (browser-safe types live there).
 */

import type { SettingKind, SettingOption } from "../../contracts/shared";
import type { AppSettingPresentationTranslation } from "../../contracts/settings-types";
import { canonicalLocale, localeFallbackChain, normalizeLocale } from "../../shared/locale";
import { migrateLegacyMustacheTemplate, validateLiquidTemplate } from "../../shared/template-rendering";
import { CORE_SETTINGS } from "./core-settings";

export type { SettingKind, SettingOption };

type SettingEnvResolver = () => unknown;

type SettingCommon = {
  key: string;
  label?: string;
  description: string;
  placeholder?: string;
  presentation?: {
    baseLocale: string;
    translations: Readonly<Record<string, AppSettingPresentationTranslation>>;
  };
  group: string;
  envFallback?: SettingEnvResolver;
  envBootstrap?: SettingEnvResolver;
};

type SettingStringLikeKind = "string" | "text" | "email" | "url" | "secret" | "image" | "cron" | "timezone" | "template";

type StringLikeSettingDef = SettingCommon & {
  kind: SettingStringLikeKind;
  default: string;
  templateVars?: string[];
};

type BooleanSettingDef = SettingCommon & {
  kind: "boolean";
  default: boolean;
};

type NumberSettingDef = SettingCommon & {
  kind: "number";
  default: number;
  min?: number;
  max?: number;
};

type EnumSettingDef = SettingCommon & {
  kind: "enum";
  default: string;
  options: SettingOption[];
};

type StringListSettingDef = SettingCommon & {
  kind: "string_list";
  default: string[];
};

type NumberListSettingDef = SettingCommon & {
  kind: "number_list";
  default: number[];
};

export type SettingDef =
  | StringLikeSettingDef
  | BooleanSettingDef
  | NumberSettingDef
  | EnumSettingDef
  | StringListSettingDef
  | NumberListSettingDef;

export type SettingValidationResult = { ok: true; value: SettingDef["default"] } | { ok: false; error: string };

/**
 * Convert a `defineApp({ settings })` map into the legacy array shape.
 *
 * `group` is derived from the dotted prefix: the bespoke admin UIs ignore it,
 * but legacy paths still group by it.
 */
const compilePresentation = (value: unknown, baseLocale: string, key: string): SettingCommon["presentation"] => {
  if (!value) return undefined;
  const catalog = value as { translations?: Readonly<Record<string, AppSettingPresentationTranslation>> };
  const translations: Record<string, AppSettingPresentationTranslation> = {};
  for (const [locale, translation] of Object.entries(catalog.translations ?? {})) {
    const canonical = canonicalLocale(locale);
    if (!canonical) throw new Error(`Setting "${key}" presentation locale ${JSON.stringify(locale)} is invalid`);
    if (canonical === baseLocale) throw new Error(`Setting "${key}" presentation must not repeat base locale ${baseLocale}`);
    if (translations[canonical]) throw new Error(`Setting "${key}" presentation locale ${canonical} is duplicated`);
    translations[canonical] = Object.freeze({ ...translation });
  }
  return Object.freeze({ baseLocale, translations: Object.freeze(translations) });
};

export const toLegacySettingDefs = (settings: Record<string, unknown>, requestedBaseLocale = "en"): SettingDef[] => {
  const baseLocale = normalizeLocale(requestedBaseLocale);
  return (
  Object.entries(settings).map(([key, def]) => {
    const d = def as Record<string, unknown>;
    return {
      key,
      group: key.split(".")[0] ?? "app",
      kind: d.kind as SettingDef["kind"],
      // The cast loses the per-kind discriminated default type but the data is
      // correct; validateSettingValue re-validates against kind anyway.
      default: d.default as never,
      label: d.label as string | undefined,
      description: (d.description as string | undefined) ?? "",
      placeholder: d.placeholder as string | undefined,
      presentation: compilePresentation(d.presentation, baseLocale, key),
      envFallback: d.envFallback as (() => unknown) | undefined,
      envBootstrap: d.envBootstrap as (() => unknown) | undefined,
      templateVars: d.templateVars as readonly string[] | undefined,
      options: d.options as ReadonlyArray<{ value: string; label: string }> | undefined,
      min: d.min as number | undefined,
      max: d.max as number | undefined,
    } as SettingDef;
  })
  );
};

export const resolveSettingPresentation = (
  def: SettingDef,
  requestedLocale?: string,
): { label: string; description: string; placeholder?: string; options?: SettingOption[] } => {
  const base = {
    label: getSettingLabel(def),
    description: def.description,
    placeholder: def.placeholder,
    options: "options" in def ? def.options : undefined,
  };
  if (!requestedLocale || !def.presentation) return base;
  const overlays = new Map(Object.entries(def.presentation.translations));
  const resolved = localeFallbackChain(requestedLocale, def.presentation.baseLocale)
    .filter((locale) => locale !== def.presentation!.baseLocale)
    .reverse()
    .reduce((value, locale) => ({ ...value, ...overlays.get(locale) }), {} as AppSettingPresentationTranslation);
  return {
    label: resolved.label ?? base.label,
    description: resolved.description ?? base.description,
    placeholder: resolved.placeholder ?? base.placeholder,
    options: base.options?.map((option) => ({ ...option, label: resolved.options?.[option.value] ?? option.label })),
  };
};

export const SETTINGS: SettingDef[] = [
  // Platform settings — app.*, ai.*, gotenberg.*, freeipa.*, user.*,
  // notifications.*, mail.*, security.*, legal.* — are declared once in
  // core-settings.ts and derived here so every container registers them, not
  // just the one that renders their admin UI.
  //
  // App-scoped settings do NOT belong here: an app declares them in its own
  // defineApp({ settings }) and renders its own admin form.
  ...toLegacySettingDefs(CORE_SETTINGS),
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toStringValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

const parseStringList = (value: unknown): string[] | null => {
  const rawValues = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? entry.split(/[,\n]/) : typeof entry === "number" ? [String(entry)] : []))
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : null;

  if (!rawValues) return null;

  return [...new Set(rawValues.map((entry) => entry.trim()).filter(Boolean))];
};

const parseNumberList = (value: unknown): number[] | null => {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/).map((entry) => entry.trim()) : null;

  if (!rawValues) return null;

  const parsed = rawValues
    .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  return [...new Set(parsed)].sort((a, b) => b - a);
};

const isValidCron = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).length === 5;
};

const isValidTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const isNonEmptyStringKind = (kind: SettingKind): kind is Exclude<SettingKind, "boolean" | "number" | "string_list" | "number_list"> =>
  kind !== "boolean" && kind !== "number" && kind !== "string_list" && kind !== "number_list";

export const getSettingLabel = (def: SettingDef): string => {
  if (def.label) return def.label;
  return def.key
    .split(".")
    .slice(1)
    .join(" ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
};

export const normalizeSettingValue = (def: SettingDef, raw: unknown): unknown => {
  switch (def.kind) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed === "true") return true;
        if (trimmed === "false") return false;
      }
      return raw;
    case "number":
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string" && raw.trim()) {
        const parsed = Number(raw.trim());
        return Number.isFinite(parsed) ? parsed : raw;
      }
      return raw;
    case "string_list":
      return parseStringList(raw) ?? raw;
    case "number_list":
      return parseNumberList(raw) ?? raw;
    case "enum": {
      const value = toStringValue(raw);
      return value === null ? raw : value.trim();
    }
    default: {
      const value = toStringValue(raw);
      if (value === null) return raw;
      return def.kind === "text" || def.kind === "template" ? value : value.trim();
    }
  }
};

export const validateSettingValue = (def: SettingDef, raw: unknown): SettingValidationResult => {
  const value = normalizeSettingValue(def, raw);

  switch (def.kind) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: `${getSettingLabel(def)} must be true or false` };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${getSettingLabel(def)} must be a valid number` };
      }
      if (def.min !== undefined && value < def.min) {
        return { ok: false, error: `${getSettingLabel(def)} must be at least ${def.min}` };
      }
      if (def.max !== undefined && value > def.max) {
        return { ok: false, error: `${getSettingLabel(def)} must be at most ${def.max}` };
      }
      return { ok: true, value };
    case "string_list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be a list of strings` };
    case "number_list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be a list of positive whole numbers` };
    case "enum":
      if (typeof value !== "string") {
        return { ok: false, error: `${getSettingLabel(def)} must be a valid option` };
      }
      return def.options.some((option) => option.value === value)
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be one of: ${def.options.map((option) => option.value).join(", ")}` };
    case "email":
      if (typeof value !== "string") return { ok: false, error: `${getSettingLabel(def)} must be a valid email address` };
      return value.length === 0 || EMAIL_RE.test(value)
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be a valid email address` };
    case "url":
    case "image":
      if (typeof value !== "string") return { ok: false, error: `${getSettingLabel(def)} must be a valid URL` };
      if (!value.length) return { ok: true, value };
      try {
        new URL(value);
        return { ok: true, value };
      } catch {
        return { ok: false, error: `${getSettingLabel(def)} must be a valid URL` };
      }
    case "cron":
      return typeof value === "string" && isValidCron(value)
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be a valid five-field cron expression` };
    case "timezone":
      if (typeof value !== "string") return { ok: false, error: `${getSettingLabel(def)} must be a valid IANA timezone` };
      return value.length === 0 || isValidTimezone(value)
        ? { ok: true, value }
        : { ok: false, error: `${getSettingLabel(def)} must be a valid IANA timezone` };
    case "template": {
      if (typeof value !== "string") return { ok: false, error: `${getSettingLabel(def)} must be text` };
      const migrated = migrateLegacyMustacheTemplate(value);
      const valid = validateLiquidTemplate(migrated);
      return valid.ok ? { ok: true, value: migrated } : { ok: false, error: `${getSettingLabel(def)} ${valid.error}` };
    }
    default:
      if (!isNonEmptyStringKind(def.kind)) {
        return { ok: false, error: `${getSettingLabel(def)} is invalid` };
      }
      return typeof value === "string" ? { ok: true, value } : { ok: false, error: `${getSettingLabel(def)} must be text` };
  }
};

/** Lookup map for quick access by key */
export const SETTINGS_MAP = new Map(SETTINGS.map((setting) => [setting.key, setting] as const));

/** Fields whose divergence changes behaviour rather than just wording. */
const CONFLICT_FIELDS = ["kind", "default", "min", "max"] as const;

export function registerSettings(defs: SettingDef[]): void {
  for (const def of defs) {
    const existingIndex = SETTINGS.findIndex((setting) => setting.key === def.key);
    if (existingIndex >= 0) {
      // Re-registering the same definition is normal: core passes CORE_SETTINGS
      // to defineApp, which re-registers what SETTINGS already derived. A
      // *conflicting* re-registration means two declarations have drifted, and
      // the winner would then depend on which container loaded which module.
      const existing = SETTINGS[existingIndex] as Record<string, unknown>;
      const incoming = def as unknown as Record<string, unknown>;
      const conflicts = CONFLICT_FIELDS.filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(incoming[field]));
      if (conflicts.length > 0) {
        throw new Error(
          `Setting "${def.key}" is registered twice with different ${conflicts.join(", ")}. ` +
            "Declare it once — platform settings belong in services/settings/core-settings.ts, " +
            "app settings in that app's defineApp({ settings }).",
        );
      }
      SETTINGS[existingIndex] = def;
    } else {
      SETTINGS.push(def);
    }
    SETTINGS_MAP.set(def.key, def);
  }
}
