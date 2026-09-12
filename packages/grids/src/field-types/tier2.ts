import Decimal from "decimal.js";
import { z } from "zod";
import { fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

// ─────────────────────────────────────────────────────────────────
// Tier-2 field types with real non-text input semantics.
//
// Email/url/phone/slug/barcode/isbn are plain text fields; the UI can
// fill common regex patterns, but storage stays text. Currency is a
// number field with a display-only `unit`. Keeping those as separate
// field types made the registry and SQL compilers larger without adding
// storage semantics.
// ─────────────────────────────────────────────────────────────────

// ── percent ───────────────────────────────────────────────────────
// Stored as a number in the user's chosen scale. UI typically shows
// "%". Range defaults to 0..100; pass `range: "fraction"` for 0..1.
const PercentConfigSchema = z.object({
  range: z.enum(["percent", "fraction"]).optional(),
  decimals: z.number().int().min(0).max(8).optional(),
});

export const percentHandler: ValueFieldType = {
  type: "percent",
  kind: "value",
  configSchema: PercentConfigSchema,
  validate(raw, configRaw, required, context) {
    const t = fieldValidationMessages(context?.locale);
    const parsed = PercentConfigSchema.safeParse(configRaw ?? {});
    if (!parsed.success) return fail(t.config);
    const range = parsed.data.range ?? "percent";
    const decimals = parsed.data.decimals ?? 2;
    const upper = range === "fraction" ? 1 : 100;

    if (raw === null || raw === undefined || raw === "") return required ? fail(t.required) : ok(null);
    if (typeof raw !== "number" && typeof raw !== "string") return fail(t.percentNumber);
    let n: Decimal;
    try {
      n = new Decimal(typeof raw === "string" ? raw.trim() : raw);
    } catch {
      return fail(t.percentNumber);
    }
    if (!n.isFinite()) return fail(t.percentNumber);
    if (n.lessThan(0) || n.greaterThan(upper)) return fail(t.percentRange({ upper }));
    // Match PostgreSQL numeric rounding before converting the bounded result
    // to the existing percent JSON number representation.
    return ok(n.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber());
  },
};

// ── duration ──────────────────────────────────────────────────────
// Stored as integer seconds. Accepts plain seconds OR HH:MM:SS / MM:SS
// strings for ergonomic input.
const DurationConfigSchema = z.object({
  unit: z.enum(["seconds", "minutes", "hours"]).optional(),
});

export const durationHandler: ValueFieldType = {
  type: "duration",
  kind: "value",
  configSchema: DurationConfigSchema,
  validate(raw, _config, required, context) {
    const t = fieldValidationMessages(context?.locale);
    if (raw === null || raw === undefined || raw === "") return required ? fail(t.required) : ok(null);
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw < 0) return fail(t.durationNonNegative);
      return ok(Math.round(raw));
    }
    if (typeof raw !== "string") return fail(t.durationInput);
    const v = raw.trim();
    // HH:MM:SS or MM:SS
    const parts = v.split(":").map((p) => p.trim());
    if (parts.length === 1) {
      const n = Number(parts[0]);
      if (!Number.isFinite(n) || n < 0) return fail(t.durationNonNegative);
      return ok(Math.round(n));
    }
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map((p) => Number(p));
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) return fail(t.duration);
      const [h, m, s] = parts.length === 3 ? nums : [0, ...nums];
      const seconds = h! * 3600 + m! * 60 + s!;
      if (!Number.isFinite(seconds)) return fail(t.durationNonNegative);
      return ok(seconds);
    }
    return fail(t.durationFormat);
  },
};
