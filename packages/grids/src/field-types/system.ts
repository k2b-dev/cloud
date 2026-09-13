import { z } from "zod";
import type { ServerGeneratedFieldKind, SystemFieldKind } from "./types";

/**
 * System fields are auto-populated by the platform on insert/update.
 * Users cannot submit values.
 *
 * Storage in JSONB happens implicitly via the records table — system fields
 * are projected at read-time from the records row's columns (created_at,
 * created_by, updated_at, updated_by). They never live in `data`.
 *
 * Generated ID fields are special: they produce stable per-record
 * identifiers written into `data` on creation or configured finalization.
 *
 * Future server-generated field kinds, such as AI-generated fields, should
 * share the same write policy: no direct record payload writes.
 */
const Empty = z.object({});

const Prefix = z.string().max(32).optional();
const Padding = z.number().int().min(1).max(16).optional();
const Assignment = z.enum(["creation", "finalization"]).optional();

export const IdStrategyConfigSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("sequence"),
    prefix: Prefix,
    padding: Padding,
    assignment: Assignment,
  }),
  z.object({
    strategy: z.literal("date_sequence"),
    prefix: Prefix,
    padding: Padding,
    period: z.enum(["year", "month", "day"]).optional(),
    assignment: Assignment,
  }),
  z.object({
    strategy: z.literal("short_code"),
    prefix: Prefix,
    length: z.number().int().min(4).max(12).optional(),
  }),
  z.object({
    strategy: z.literal("random_code"),
    prefix: Prefix,
    groups: z.number().int().min(2).max(4).optional(),
    segmentLength: z.number().int().min(3).max(6).optional(),
  }),
  z.object({
    strategy: z.literal("uuid"),
    prefix: Prefix,
  }),
  z.object({
    strategy: z.literal("uuidv7"),
    prefix: Prefix,
  }),
  z.object({
    strategy: z.literal("ulid"),
    prefix: Prefix,
  }),
]);

export const IdFieldConfigSchema = z.preprocess((raw) => {
  if (typeof raw === "object" && raw !== null && !("strategy" in raw)) {
    return { ...(raw as Record<string, unknown>), strategy: "sequence" };
  }
  return raw;
}, IdStrategyConfigSchema);

export const createdAtHandler: SystemFieldKind = {
  type: "created_at",
  kind: "system",
  configSchema: Empty,
};

export const updatedAtHandler: SystemFieldKind = {
  type: "updated_at",
  kind: "system",
  configSchema: Empty,
};

export const createdByHandler: SystemFieldKind = {
  type: "created_by",
  kind: "system",
  configSchema: Empty,
};

export const updatedByHandler: SystemFieldKind = {
  type: "updated_by",
  kind: "system",
  configSchema: Empty,
};

export const idHandler: ServerGeneratedFieldKind = {
  type: "id",
  kind: "serverGenerated",
  configSchema: IdFieldConfigSchema,
};
