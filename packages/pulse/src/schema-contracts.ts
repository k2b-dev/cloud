import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { z } from "zod";
import { METRIC_TYPES } from "./contracts";

/** Browser-safe contract of the Pulse data catalog: which data kinds a base holds and what their entries look like. */
export const SCHEMA_MAX_METRICS = 500;
export const SCHEMA_MAX_EVENT_KINDS = 200;
export const SCHEMA_MAX_STATE_KEYS = 200;
// 200 kinds × (40 fields + 1 row for events without attributes) = 8,200 store rows, below the 10,000-row read limit.
export const SCHEMA_MAX_FIELDS = 40;
export const SCHEMA_MAX_DIMENSIONS = 32;
export const SCHEMA_SAMPLE_ROWS = 5;
/** Newest events per kind that field names, types and fill rates are inferred from. */
export const SCHEMA_FIELD_SAMPLE_ROWS = 10_000;
/** Field sampling reads events up to this many days before the newest event of the kinds it reads. */
export const SCHEMA_EVENT_WINDOW_DAYS = 7;
/** Metric samples come from the hour before the metric's newest sample. */
export const SCHEMA_METRIC_SAMPLE_WINDOW_HOURS = 1;
export const SCHEMA_NAME_MAX_LENGTH = 500;
export const SCHEMA_TEXT_MAX_LENGTH = 200;
export const SCHEMA_JSON_SAMPLE_MAX_BYTES = 2048;
export const SCHEMA_DIMENSIONS_SAMPLE_MAX_BYTES = 1024;
/** One result fits a capability answer and leaves 16 KiB for the platform envelope. */
export const SCHEMA_RESULT_MAX_BYTES = CAPABILITY_MAX_RESULT_BYTES - 16 * 1024;
export const SCHEMA_CACHE_SECONDS = 300;

export const SCHEMA_FIELD_TYPES = ["string", "number", "boolean", "object", "array", "null"] as const;
export type SchemaFieldType = (typeof SCHEMA_FIELD_TYPES)[number];

const Timestamp = z.string().datetime({ offset: true });
const Name = z.string().min(1).max(SCHEMA_NAME_MAX_LENGTH);
const Text = z.string().max(SCHEMA_TEXT_MAX_LENGTH);
const ShortId = z.string().regex(/^[0-9A-Za-z]{6}$/);
const Count = z.number().int().nonnegative();
const Scalar = z.union([z.string().max(SCHEMA_JSON_SAMPLE_MAX_BYTES), z.number(), z.boolean(), z.null()]);
const JsonObject = z.record(z.string(), z.unknown());

/** One exact name of a metric, event kind or state key. */
export const SchemaKindFilterSchema = z
  .string()
  .min(1)
  .max(SCHEMA_NAME_MAX_LENGTH)
  .regex(/^[^\u0000-\u001f]+$/, "Control characters are not allowed")
  .describe("Exact name of one metric, event kind or state key. Adds the newest entries of that kind.");

export const SchemaReadInputSchema = z.object({ kind: SchemaKindFilterSchema.optional() }).strict();
export type SchemaReadInput = z.infer<typeof SchemaReadInputSchema>;

export const SchemaFieldSchema = z
  .object({
    key: Name,
    /** Most frequent non-null type; `null` only when every sampled value is null. */
    type: z.enum(SCHEMA_FIELD_TYPES),
    /** Every observed type, most frequent first. */
    types: z.array(z.enum(SCHEMA_FIELD_TYPES)).min(1).max(SCHEMA_FIELD_TYPES.length),
    present: Count,
    /** Share of sampled rows that have the key, 0 to 1. */
    fillRate: z.number().min(0).max(1),
  })
  .strict();
export type SchemaField = z.infer<typeof SchemaFieldSchema>;

export const SchemaEventSampleSchema = z
  .object({
    id: Text,
    ts: Timestamp,
    value: z.number().nullable(),
    sourceId: ShortId.nullable(),
    actorId: Text,
    sessionId: Text,
    correlationId: Text,
    resourceKey: Text,
    dimensions: JsonObject.nullable(),
    /** Null when the stored attributes exceed the sample budget; see attributesTruncated. */
    attributes: JsonObject.nullable(),
    attributesTruncated: z.boolean(),
  })
  .strict();

export const SchemaMetricSampleSchema = z
  .object({
    ts: Timestamp,
    value: z.number(),
    sourceId: ShortId.nullable(),
    resourceKey: Text,
    dimensions: JsonObject.nullable(),
  })
  .strict();

export const SchemaStateSampleSchema = z
  .object({
    variantKey: Text,
    value: Scalar,
    valueTruncated: z.boolean(),
    updatedAt: Timestamp,
    sourceId: ShortId.nullable(),
    resourceKey: Text,
    dimensions: JsonObject.nullable(),
  })
  .strict();

export const SchemaMetricSchema = z
  .object({
    name: Name,
    type: z.enum(METRIC_TYPES),
    unit: Text.nullable(),
    seriesCount: Count,
    lastSampleAt: Timestamp.nullable(),
    dimensions: z.array(z.object({ key: Name, values: Count }).strict()).max(SCHEMA_MAX_DIMENSIONS),
    /** Null unless this metric was requested by name, or when the result budget dropped it. */
    samples: z.array(SchemaMetricSampleSchema).max(SCHEMA_SAMPLE_ROWS).nullable(),
  })
  .strict();

export const SchemaEventKindSchema = z
  .object({
    kind: Name,
    firstSeenAt: Timestamp,
    lastSeenAt: Timestamp,
    sampledRows: Count.max(SCHEMA_FIELD_SAMPLE_ROWS),
    /** Null when no event of this kind was in the sampling window, or when the result budget dropped it. */
    fields: z.array(SchemaFieldSchema).max(SCHEMA_MAX_FIELDS).nullable(),
    fieldsTruncated: z.boolean(),
    samples: z.array(SchemaEventSampleSchema).max(SCHEMA_SAMPLE_ROWS).nullable(),
  })
  .strict();

export const SchemaStateKeySchema = z
  .object({
    key: Name,
    firstSeenAt: Timestamp,
    variantCount: Count,
    updatedAt: Timestamp.nullable(),
    samples: z.array(SchemaStateSampleSchema).max(SCHEMA_SAMPLE_ROWS).nullable(),
  })
  .strict();

const section = <T extends z.ZodType>(item: T, max: number) => z.object({ total: Count, items: z.array(item).max(max) }).strict();

export const BaseSchemaReadSchema = z
  .object({
    baseId: ShortId,
    generatedAt: Timestamp,
    kind: SchemaKindFilterSchema.nullable(),
    /** True when a list was cut at its maximum or entries were dropped to fit the result budget. */
    truncated: z.boolean(),
    metrics: section(SchemaMetricSchema, SCHEMA_MAX_METRICS),
    events: section(SchemaEventKindSchema, SCHEMA_MAX_EVENT_KINDS),
    states: section(SchemaStateKeySchema, SCHEMA_MAX_STATE_KEYS),
  })
  .strict();
export type BaseSchemaRead = z.infer<typeof BaseSchemaReadSchema>;
